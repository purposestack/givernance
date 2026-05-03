#!/usr/bin/env bash
set -euo pipefail

# Smoke test the local Keycloak 26 realm after `docker compose up -d`.
# Verifies the acceptance criteria from issue #114:
#   1. The seeded super-admin user can obtain a token (login works).
#   2. The access token carries the `org_id` claim required by the API.
#   3. The platform Organization exists with the expected org_id attribute.
#   4. The seed user is a member of that Organization.
#
# Runs against the running Docker stack — not CI (the CI job doesn't start
# Keycloak today; see ADR-017 and .github/workflows/ci.yml). Wired into
# scripts/dev-up.sh so every local bring-up validates the realm.
#
# Env (defaults shown):
#   KEYCLOAK_URL             (http://localhost:8080)
#   KEYCLOAK_ADMIN           (admin)             — master realm bootstrap user
#   KEYCLOAK_ADMIN_PASSWORD  (admin)
#   KEYCLOAK_REALM           (givernance)
#   KEYCLOAK_SEED_USERNAME   (admin@givernance.org)
#   KEYCLOAK_SEED_PASSWORD   (admin-localdev-12)  — must satisfy realm passwordPolicy
#   KEYCLOAK_SEED_ORG_ID     (00000000-0000-0000-0000-0000000000a1)
#   KEYCLOAK_SEED_ORG_ALIAS  (platform)
#
# Exit: 0 when every check passes; 1 on the first failure with a diagnostic
# on stderr. Guarded to refuse non-localhost Keycloak URLs (see below).
#
# Usage: scripts/keycloak-smoke-test.sh

KC_URL="${KEYCLOAK_URL:-http://localhost:8080}"
KC_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
REALM="${KEYCLOAK_REALM:-givernance}"
SEED_USERNAME="${KEYCLOAK_SEED_USERNAME:-admin@givernance.org}"
SEED_PASSWORD="${KEYCLOAK_SEED_PASSWORD:-admin-localdev-12}"
SEED_ORG_ID="${KEYCLOAK_SEED_ORG_ID:-00000000-0000-0000-0000-0000000000a1}"
SEED_ORG_ALIAS="${KEYCLOAK_SEED_ORG_ALIAS:-platform}"

# Refuse to run against anything other than a local / docker-internal
# Keycloak. This script submits Resource-Owner-Password credentials with
# the dev admin password — accidentally pointing it at a staging/prod
# Keycloak would rack up the brute-force counter on a real user.
case "$KC_URL" in
  http://localhost:*|http://127.0.0.1:*|http://[::1]:*|http://keycloak:*|http://keycloak.*)
    ;;
  *)
    printf '   ✗ refusing to run against non-localhost Keycloak URL: %s\n' "$KC_URL" >&2
    exit 2
    ;;
esac

fail() {
  printf '   ✗ %s\n' "$*" >&2
  exit 1
}

ok() { printf '   ✓ %s\n' "$*"; }

# URL-encode a value for safe interpolation.
urlencode() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# Summarise an auth-endpoint error body WITHOUT leaking an access_token /
# refresh_token on the rare case Keycloak returns a partial response.
redact_login_response() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f"<unparseable> ({e.__class__.__name__})")
    sys.exit(0)
print(json.dumps({
    "error": d.get("error"),
    "error_description": d.get("error_description"),
    "has_access_token": bool(d.get("access_token")),
}))
'
}

# Retry up to N attempts while the realm finishes reconciling on a cold boot.
# The Organization import can settle after `.well-known` is reachable; without
# this loop, the first curl races and step 3 flakes.
retry_for_token() {
  local attempt=0
  local max_attempts=10
  local delay=2
  while [ $attempt -lt $max_attempts ]; do
    attempt=$((attempt + 1))
    local body
    body=$(curl -sS -X POST "${KC_URL}/realms/$(urlencode "$REALM")/protocol/openid-connect/token" \
      --data-urlencode "grant_type=password" \
      --data-urlencode "client_id=admin-cli" \
      --data-urlencode "username=${SEED_USERNAME}" \
      --data-urlencode "password=${SEED_PASSWORD}" \
      --data-urlencode "scope=openid organization")
    local tok
    tok=$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("access_token") or "")
except Exception:
    print("")
')
    if [ -n "$tok" ]; then
      printf '%s' "$tok"
      return 0
    fi
    # Stash the latest body for the final error message; don't print on
    # every attempt (would spam the dev-up log).
    LAST_LOGIN_BODY="$body"
    sleep "$delay"
  done
  return 1
}

# ── 1. Log in as the super-admin user via Resource Owner Password Credentials
#       on the realm's built-in `admin-cli` client (direct grants enabled by
#       default). Retry to cover realm-import settling after `.well-known`.
if ! access_token=$(retry_for_token); then
  printf '   login response (redacted): %s\n' \
    "$(printf '%s' "${LAST_LOGIN_BODY:-}" | redact_login_response)" >&2
  fail "Failed to obtain access token for ${SEED_USERNAME} after 10 retries — user cannot log in."
fi
ok "User '${SEED_USERNAME}' can log in (RO password grant on admin-cli)."

# ── 2. Decode the access-token payload and assert `org_id` claim is present.
#      Token is a standard JWT (header.payload.signature); we only need the
#      payload as base64url-decoded JSON.
payload_b64=$(printf '%s' "$access_token" | cut -d. -f2)
# Pad base64url to a multiple of 4 for stdlib decoding (-d on Linux uses
# strict padding; the helper below handles it portably).
payload_json=$(printf '%s' "$payload_b64" | python3 -c '
import base64, sys
raw = sys.stdin.read().strip()
pad = "=" * (-len(raw) % 4)
print(base64.urlsafe_b64decode(raw + pad).decode("utf-8"))
')

org_id_claim=$(printf '%s' "$payload_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("org_id") or "")
')
if [ -z "$org_id_claim" ]; then
  printf '   token payload: %s\n' "$payload_json" >&2
  fail "Access token missing required 'org_id' claim."
fi
if [ "$org_id_claim" != "$SEED_ORG_ID" ]; then
  fail "Access token 'org_id' claim = '${org_id_claim}', expected '${SEED_ORG_ID}'."
fi
ok "Access token carries org_id=${org_id_claim}."

# ── 2.bis Assert the standard OIDC `sub` claim is present. In Keycloak 26
#         `sub` is emitted by the `basic` client scope's oidc-sub-mapper;
#         a realm upgraded from an older Keycloak version won't have
#         `basic` attached to hand-rolled clients, so the sync script
#         attaches it explicitly. The web callback's JWT verifier fails
#         without `sub`, so guard against the regression here.
sub_claim=$(printf '%s' "$payload_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("sub") or "")
')
if [ -z "$sub_claim" ]; then
  printf '   token payload: %s\n' "$payload_json" >&2
  fail "Access token missing required 'sub' claim — is the 'basic' client scope attached?"
fi
ok "Access token carries standard OIDC sub claim."

# ── 3. Assert the nested Keycloak 26 `organization` claim is also emitted
#      via the oidc-organization-membership-mapper (on the `organization`
#      client scope — see docs/21 §2.1). Carries the Keycloak org UUID and
#      every Organization attribute.
org_claim_present=$(printf '%s' "$payload_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
org = d.get("organization")
# Mapper emits either {"alias": {...}} (flat) or a list of aliases
# depending on `multivalued`. Accept both shapes.
if isinstance(org, dict) and org:
    print("yes")
elif isinstance(org, list) and org:
    print("yes")
else:
    print("no")
')
if [ "$org_claim_present" != "yes" ]; then
  printf '   token payload: %s\n' "$payload_json" >&2
  fail "Access token missing 'organization' membership claim (oidc-organization-membership-mapper)."
fi
ok "Access token carries the nested 'organization' claim."

# ── 4. Verify the platform Organization exists and the admin user is a member.
#      Requires the master-admin token; we reuse the same path the sync
#      script uses.
master_token=$(curl -sS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=${KC_ADMIN}" \
  --data-urlencode "password=${KC_ADMIN_PASSWORD}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

orgs=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/$(urlencode "$REALM")/organizations?search=$(urlencode "$SEED_ORG_ALIAS")")
org_id_kc=$(printf '%s' "$orgs" | ALIAS="$SEED_ORG_ALIAS" python3 -c '
import json, os, sys
wanted = os.environ["ALIAS"]
try:
    data = json.load(sys.stdin)
except Exception:
    data = None
# Keycloak returns a list on success, an object with `error` / `errorMessage`
# on failure (401/403/500 etc.). Distinguish so the smoke test can tell the
# dev WHY the lookup failed, instead of mis-reporting "not found".
if isinstance(data, list):
    for o in data:
        if o.get("alias") == wanted:
            print(o["id"])
            break
elif isinstance(data, dict) and (data.get("error") or data.get("errorMessage")):
    print("__API_ERROR__:" + json.dumps(data))
')
if [ -z "$org_id_kc" ]; then
  fail "Platform Organization with alias='${SEED_ORG_ALIAS}' not found. Raw response: ${orgs}"
fi
case "$org_id_kc" in
  __API_ERROR__:*)
    fail "Organizations API error while looking up '${SEED_ORG_ALIAS}': ${org_id_kc#__API_ERROR__:}"
    ;;
esac
ok "Platform Organization '${SEED_ORG_ALIAS}' exists (id=${org_id_kc})."

org_detail=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}/organizations/${org_id_kc}")
org_attr_value=$(printf '%s' "$org_detail" | python3 -c '
import json, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
vals = attrs.get("org_id") or []
print(vals[0] if vals else "")
')
if [ "$org_attr_value" != "$SEED_ORG_ID" ]; then
  fail "Platform Organization attributes.org_id='${org_attr_value}', expected '${SEED_ORG_ID}'."
fi
ok "Platform Organization has attributes.org_id=${SEED_ORG_ID}."

members=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}/organizations/${org_id_kc}/members")
has_admin=$(printf '%s' "$members" | USER="$SEED_USERNAME" python3 -c '
import json, os, sys
wanted = os.environ["USER"]
print("yes" if any(m.get("username") == wanted for m in json.load(sys.stdin)) else "no")
')
if [ "$has_admin" != "yes" ]; then
  fail "User '${SEED_USERNAME}' is not a member of the '${SEED_ORG_ALIAS}' Organization."
fi
ok "User '${SEED_USERNAME}' is a member of '${SEED_ORG_ALIAS}'."

# === [step-up] === Section banner for greppability in CI logs (multi-
# agent review Logs N-16, PR #251) — `grep -A 100 '\[step-up\]' ci.log`
# slices the step-up checks out without mixing with the realm/users
# checks above.
printf '\n[step-up] step-up MFA flow checks (issue #250)\n'

# Step-up MFA flow checks (issue #250). Without these, a sync-script
# regression that drops the browser-with-step-up flow / acr.loa.map /
# browserFlow assignment only surfaces the next time someone tries to
# impersonate — which on staging means a confused operator filing a
# bug, not a smoke-test failure. These checks lock the contract:
#   - the realm.attributes."acr.loa.map" attribute exists and maps "2"
#   - the realm.browserFlow points at the custom flow
#   - the custom flow is present in the authentication/flows list
#
# Step-up checks emit `[step-up]` in their messages so CI logs can be
# sliced to this section with `grep '\[step-up\]'` (multi-agent review
# Logs N-16, PR #251).
realm_repr=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}")
acr_loa_map=$(printf '%s' "$realm_repr" | python3 -c '
import json, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
print(attrs.get("acr.loa.map", ""))
')
case "$acr_loa_map" in
  *'"2"'*':'*|*'\"2\"'*':'*)
    ok "Realm attribute acr.loa.map maps acr=2."
    ;;
  *)
    fail "Realm attribute acr.loa.map missing or doesn't map acr=2 (value='${acr_loa_map}'). The Conditional-LoA authenticator's emitted level won't translate to the acr claim — every impersonation attempt will 401 acr_insufficient."
    ;;
esac

browser_flow=$(printf '%s' "$realm_repr" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("browserFlow", ""))
')
if [ "$browser_flow" != "browser-with-step-up" ]; then
  fail "Realm.browserFlow='${browser_flow}', expected 'browser-with-step-up'. The custom step-up flow won't fire on login."
fi
ok "Realm.browserFlow points at the custom step-up flow."

flows=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}/authentication/flows")
has_flow=$(printf '%s' "$flows" | python3 -c '
import json, sys
d = json.load(sys.stdin)
flows = d if isinstance(d, list) else []
print("yes" if any(f.get("alias") == "browser-with-step-up" for f in flows) else "no")
')
if [ "$has_flow" != "yes" ]; then
  fail "Authentication flow 'browser-with-step-up' not found. Custom step-up flow missing — the sync script's flow-creation block didn't run or failed mid-way."
fi
ok "Authentication flow 'browser-with-step-up' exists."

# Lock the EXACT two-conditional shape from the KC 26 docs §"Creating a
# browser login flow with step-up mechanism". A single-conditional shape
# (where username/password is a REQUIRED sibling of the LoA-2 conditional)
# triggers OTP enrolment on EVERY login because
# ConditionalLoaAuthenticator.matchCondition() short-circuits to TRUE
# whenever currentAuthenticationLoa < MINIMUM_LOA — which is the case at
# the start of every fresh authentication. This check would have caught
# the regression that blocked PR #251 for 6 iterations.
exec_list=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}/authentication/flows/browser-with-step-up/executions")
shape_ok=$(printf '%s' "$exec_list" | python3 -c '
import json, sys
try:
    execs = json.load(sys.stdin)
except Exception:
    print("no")
    sys.exit(0)
if not isinstance(execs, list):
    print("no")
    sys.exit(0)
required = {
    (0, "auth-cookie"),
    (0, "identity-provider-redirector"),
    (0, "browser-with-step-up forms"),
    (1, "browser-with-step-up loa-1"),
    (1, "browser-with-step-up loa-2"),
    (2, "auth-username-password-form"),
    (2, "auth-otp-form"),
    (2, "conditional-level-of-authentication"),
}
seen = set()
legacy = False
for ex in execs:
    ident = ex.get("providerId") or ex.get("displayName") or ""
    seen.add((ex.get("level"), ident))
    if ex.get("level") == 1 and ex.get("providerId") == "auth-username-password-form":
        legacy = True  # username/password as direct child of "forms"
print("legacy" if legacy else ("yes" if required.issubset(seen) else "no"))
')
case "$shape_ok" in
  yes)
    ok "Step-up flow has the documented two-conditional shape (LoA-1 → password, LoA-2 → OTP)."
    ;;
  legacy)
    fail "Step-up flow has the LEGACY single-conditional shape (auth-username-password-form is a direct child of 'browser-with-step-up forms'). Every normal login will be intercepted by CONFIGURE_TOTP because ConditionalLoaAuthenticator.matchCondition() returns true whenever currentAuthenticationLoa < MINIMUM_LOA. Re-run scripts/keycloak-sync-realm.sh to rebuild the flow."
    ;;
  *)
    printf '   executions list:\n%s\n' "$exec_list" >&2
    fail "Step-up flow shape doesn't match the expected two-conditional layout (missing one of: loa-1 sub-flow, loa-2 sub-flow, conditional execution at depth 2)."
    ;;
esac

# Lock the LoA configs so a future regression that drops loa-1-config or
# loses the loa-2-config attachment is caught here, not in production.
config_check=$(printf '%s' "$exec_list" | python3 -c '
import json, sys
execs = json.load(sys.stdin)
parents = {}
results = {"loa-1": None, "loa-2": None}
for ex in execs:
    depth = ex.get("level", 0)
    if ex.get("authenticationFlow"):
        parents[depth] = ex.get("displayName") or ""
        for d in list(parents):
            if d > depth:
                del parents[d]
        continue
    if ex.get("providerId") != "conditional-level-of-authentication":
        continue
    parent = parents.get(depth - 1) or ""
    cfg = ex.get("authenticationConfig")
    if parent.endswith("loa-1"):
        results["loa-1"] = cfg
    elif parent.endswith("loa-2"):
        results["loa-2"] = cfg
print(json.dumps(results))
')
loa1_cfg=$(printf '%s' "$config_check" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("loa-1") or "")')
loa2_cfg=$(printf '%s' "$config_check" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("loa-2") or "")')
if [ -z "$loa1_cfg" ]; then
  fail "Conditional under 'browser-with-step-up loa-1' has no authenticatorConfig attached. Without it the LoA-1 conditional doesn't push currentLoa to 1 and the LoA-2 conditional fires on every login."
fi
if [ -z "$loa2_cfg" ]; then
  fail "Conditional under 'browser-with-step-up loa-2' has no authenticatorConfig attached. Without it the LoA-2 conditional defaults to MINIMUM_LOA=0 and fires on every login."
fi
loa1_body=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}/authentication/config/${loa1_cfg}")
loa2_body=$(curl -sS -H "Authorization: Bearer ${master_token}" \
  "${KC_URL}/admin/realms/${REALM}/authentication/config/${loa2_cfg}")
loa1_level=$(printf '%s' "$loa1_body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("config") or {}).get("loa-condition-level",""))')
loa2_level=$(printf '%s' "$loa2_body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("config") or {}).get("loa-condition-level",""))')
if [ "$loa1_level" != "1" ]; then
  fail "loa-1 conditional has loa-condition-level='${loa1_level}', expected '1'."
fi
if [ "$loa2_level" != "2" ]; then
  fail "loa-2 conditional has loa-condition-level='${loa2_level}', expected '2'."
fi
ok "Step-up LoA configs locked: loa-1=level 1, loa-2=level 2."

# QA-D (multi-agent review, PR #251): the previous shape check only
# verifies `auth-otp-form` is PRESENT at level 2. A regression that
# flips its `requirement` enum to DISABLED would silently turn off MFA
# while passing every other smoke test. Lock the enum to REQUIRED so
# the next deploy that drops the requirement fails closed.
otp_requirement=$(printf '%s' "$exec_list" | python3 -c '
import json, sys
execs = json.load(sys.stdin)
for ex in execs:
    if ex.get("level") == 2 and ex.get("providerId") == "auth-otp-form":
        print(ex.get("requirement", ""))
        sys.exit(0)
print("")
')
if [ "$otp_requirement" != "REQUIRED" ]; then
  fail "Step-up: auth-otp-form at LoA-2 has requirement='${otp_requirement}', expected 'REQUIRED'. MFA is silently off — every acr_values=2 request will skip the OTP prompt."
fi
ok "Step-up: auth-otp-form at LoA-2 is REQUIRED (MFA actually fires)."

# End-to-end: a normal login (no acr_values) MUST NOT be redirected to
# CONFIGURE_TOTP. This is the inverse of the bug PR #251 fixes — the
# checks above confirm the static realm shape is correct, and this curl
# confirms the runtime behaviour matches.
COOKIE_JAR=$(mktemp)
trap "rm -f \"$COOKIE_JAR\"" EXIT
LOGIN_PAGE=$(curl -sS -c "$COOKIE_JAR" \
  "${KC_URL}/realms/${REALM}/protocol/openid-connect/auth?client_id=givernance-web&response_type=code&scope=openid&redirect_uri=http://localhost:3000/api/auth/callback&state=smoke&nonce=smoke")
ACTION_URL=$(printf '%s' "$LOGIN_PAGE" | python3 -c '
import sys, re, html
m = re.search(r"<form[^>]*id=\"kc-form-login\"[^>]*action=\"([^\"]+)\"", sys.stdin.read())
if not m:
    sys.exit(0)
print(html.unescape(m.group(1)))
')
if [ -z "$ACTION_URL" ]; then
  fail "Could not extract login form action URL from KC login page — login UI may be broken."
fi
LOGIN_RESP=$(curl -sS -i -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -X POST "$ACTION_URL" \
  --data-urlencode "username=${SEED_USERNAME}" \
  --data-urlencode "password=${SEED_PASSWORD}" \
  --data-urlencode "credentialId=" \
  -H "Content-Type: application/x-www-form-urlencoded")
LOC=$(printf '%s' "$LOGIN_RESP" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r' | head -1)
case "$LOC" in
  *"required-action"*"CONFIGURE_TOTP"*)
    fail "Normal login (no acr_values) was intercepted by CONFIGURE_TOTP. The step-up MFA flow is firing OTP enrolment on every login. Location: ${LOC}"
    ;;
  *"http://localhost:3000/api/auth/callback"*|*"localhost:3000/api/auth/callback"*)
    ok "Normal login (no acr_values) completes without OTP — redirected straight to the app callback."
    ;;
  "")
    fail "Normal login produced no Location header. Response head:\n$(printf '%s' "$LOGIN_RESP" | head -20)"
    ;;
  *)
    fail "Normal login redirected to an unexpected URL: ${LOC}"
    ;;
esac

printf '\n Keycloak smoke test passed.\n'
