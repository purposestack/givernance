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
#   KEYCLOAK_SEED_PASSWORD   (admin)
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
SEED_PASSWORD="${KEYCLOAK_SEED_PASSWORD:-admin}"
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

# ── 3. Assert the nested Keycloak 26 `organization` claim is also emitted
#      via the oidc-organization-membership-mapper — this is what future
#      consumers read from (docs/21 §2.1.bis).
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

printf '\n Keycloak smoke test passed.\n'
