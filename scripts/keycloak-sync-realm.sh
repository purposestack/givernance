#!/usr/bin/env bash
set -euo pipefail

# Idempotently reconcile the running Keycloak realm with the expected state.
#
# Keycloak's `start-dev --import-realm` uses IGNORE_EXISTING strategy: when the
# realm already exists, changes to infra/keycloak/realm-givernance.json are NOT
# re-applied. This script patches a live Keycloak so dev environments created
# before a realm JSON update recover without wiping the Keycloak database.
#
# Reconciles:
#   - Realm user profile: unmanagedAttributePolicy=ENABLED (permits org_id / role)
#   - Realm: `organization` client scope exists (KC creates it when
#     Organizations is enabled, but a realm upgraded from <26 or with the
#     flag toggled post-import may be missing it — we create it if so)
#   - Scope `organization`: carries `org_id`, `role`, and the rich
#     `organization` membership mapper. Wiring lives on the scope (not on
#     individual clients) so any client with `organization` as a default or
#     optional scope — web login flow on `givernance-web`, RO password flow
#     on `admin-cli` for the smoke test — sees the same claims.
#   - Client `givernance-web`: legacy client-level mappers removed (they
#     would duplicate the scope's claims); `organization` scope attached
#     as DEFAULT so every web token carries membership + org_id + role.
#   - Client `admin-cli`: `organization` scope attached as OPTIONAL, and
#     `client.use.lightweight.access.token.enabled=false` so the access
#     token carries the full claim set (Keycloak 26 defaults admin-cli to
#     lightweight, which strips every mapper-contributed claim).
#   - User `admin@givernance.org`: `org_id` and `role` attributes
#   - User `admin@givernance.org`: `super_admin` realm role assignment
#   - Organizations (Keycloak 26+): platform org exists with `org_id` attribute,
#     seed user is a member (ADR-016 / issue #114).
#
# Usage: scripts/keycloak-sync-realm.sh

KC_URL="${KEYCLOAK_URL:-http://localhost:8080}"
KC_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
REALM="${KEYCLOAK_REALM:-givernance}"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:-givernance-web}"
SEED_USERNAME="${KEYCLOAK_SEED_USERNAME:-admin@givernance.org}"
SEED_ORG_ID="${KEYCLOAK_SEED_ORG_ID:-00000000-0000-0000-0000-0000000000a1}"
SEED_USER_ROLE="${KEYCLOAK_SEED_USER_ROLE:-org_admin}"
SEED_REALM_ROLES="${KEYCLOAK_SEED_REALM_ROLES:-super_admin}"
SEED_ORG_ALIAS="${KEYCLOAK_SEED_ORG_ALIAS:-platform}"
SEED_ORG_NAME="${KEYCLOAK_SEED_ORG_NAME:-Givernance Platform}"
# Non-routable domain by design: a *real* `givernance.org` mailbox must not be
# auto-routed to this dev-only Organization by Keycloak's Home IdP Discovery
# (the moment an IdP is bound to the org). See review thread on PR #139.
SEED_ORG_DOMAIN="${KEYCLOAK_SEED_ORG_DOMAIN:-platform.givernance.invalid}"

log()  { printf '   %s\n' "$*"; }
warn() { printf '   %s\n' "$*" >&2; }

# URL-encode a string for safe interpolation into query parameters / form bodies.
# Using python3 (stdlib `urllib.parse`) keeps us portable across macOS/Linux
# without needing to jq or shell out to a language runtime per call.
urlencode() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# Fetch an admin-realm token using form-urlencoded credentials. `--data-urlencode`
# is critical here: a dev with `=` / `&` / `+` characters in their password or
# username would otherwise submit a malformed request and get silent auth failure.
token_resp=$(curl -sS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=${KC_ADMIN}" \
  --data-urlencode "password=${KC_ADMIN_PASSWORD}")
ADMIN_TOKEN=$(printf '%s' "$token_resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

auth=(-H "Authorization: Bearer ${ADMIN_TOKEN}")

# If the realm itself is missing (e.g. fresh container still importing), bail out.
if ! curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" "${KC_URL}/admin/realms/${REALM}" | grep -q '^200$'; then
  log "Realm '${REALM}' not present yet — skipping sync."
  exit 0
fi

# 1. Ensure the realm user profile allows unmanaged attributes (required in Keycloak 24+
#    for `org_id` since it's not part of the declarative profile).
profile=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users/profile")
patched_profile=$(printf '%s' "$profile" | python3 -c '
import json, sys
d = json.load(sys.stdin)
changed = False
if d.get("unmanagedAttributePolicy") != "ENABLED":
    d["unmanagedAttributePolicy"] = "ENABLED"
    changed = True
print(json.dumps({"changed": changed, "profile": d}))
')
if printf '%s' "$patched_profile" | python3 -c 'import json,sys;sys.exit(0 if json.load(sys.stdin)["changed"] else 1)'; then
  new_profile=$(printf '%s' "$patched_profile" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["profile"]))')
  curl -sS -o /dev/null -w 'profile update: HTTP %{http_code}\n' \
    -X PUT "${KC_URL}/admin/realms/${REALM}/users/profile" \
    "${auth[@]}" -H "Content-Type: application/json" -d "$new_profile"
  log "Set unmanagedAttributePolicy=ENABLED on realm '${REALM}'."
else
  log "User profile already permissive — no change."
fi

# 1.b Reconcile realm-level fields that `--import-realm` silently skips
#     when the realm already exists. Despite `KC_IMPORT_STRATEGY=
#     OVERWRITE_EXISTING` being set in the env, the start-time import
#     path still uses IGNORE_EXISTING (the env var only takes effect via
#     the dedicated `kc.sh import` command). Confirmed in KC 26.6.1
#     boot logs:
#       "Realm 'givernance' already exists. Import skipped"
#       "Strategy: IGNORE_EXISTING"
#
#     Reconciling here means the realm JSON stays the source of truth
#     for these fields even when the start-time import was lossy or the
#     operator hand-edited them via the admin console:
#       - passwordPolicy → matches API-side `minLength: 12` and prevents
#         a future direct-admin path from setting trivial passwords.
#         (PR #143 review also caught a `notUsername(undefined)` accident
#         that this same reconciliation block now repairs.)
#       - loginTheme → required for the custom Givernance theme to
#         render; without it KC silently falls back to `keycloak.v2`.
#       - internationalizationEnabled / supportedLocales / defaultLocale
#         → drive the locale picker and the per-locale message bundles
#         (issue #153 / locale-resolution flows).
DESIRED_PASSWORD_POLICY="${KEYCLOAK_PASSWORD_POLICY:-length(12) and notUsername}"
realm_repr=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}")
patched_realm=$(printf '%s' "$realm_repr" | DESIRED_POLICY="$DESIRED_PASSWORD_POLICY" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
desired_policy = os.environ["DESIRED_POLICY"]
desired_login_theme = "givernance"
desired_i18n = True
desired_locales = ["en", "fr"]
desired_default_locale = "en"
desired_reset_password = True

changes = []
if d.get("passwordPolicy") != desired_policy:
    d["passwordPolicy"] = desired_policy
    changes.append("passwordPolicy")
if d.get("loginTheme") != desired_login_theme:
    d["loginTheme"] = desired_login_theme
    changes.append("loginTheme")
if d.get("internationalizationEnabled") != desired_i18n:
    d["internationalizationEnabled"] = desired_i18n
    changes.append("internationalizationEnabled")
if sorted(d.get("supportedLocales") or []) != sorted(desired_locales):
    d["supportedLocales"] = desired_locales
    changes.append("supportedLocales")
if d.get("defaultLocale") != desired_default_locale:
    d["defaultLocale"] = desired_default_locale
    changes.append("defaultLocale")
if d.get("resetPasswordAllowed") != desired_reset_password:
    d["resetPasswordAllowed"] = desired_reset_password
    changes.append("resetPasswordAllowed")

print(json.dumps({"changes": changes, "realm": d}))
')
realm_changes=$(printf '%s' "$patched_realm" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["changes"]))')
if [ -n "$realm_changes" ]; then
  new_realm=$(printf '%s' "$patched_realm" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["realm"]))')
  curl -sS -o /dev/null -w 'realm fields update: HTTP %{http_code}\n' \
    -X PUT "${KC_URL}/admin/realms/${REALM}" \
    "${auth[@]}" -H "Content-Type: application/json" -d "$new_realm"
  log "Reconciled realm fields on '${REALM}': ${realm_changes}"
else
  log "Realm fields (passwordPolicy, loginTheme, i18n, locales) already match — no change."
fi

# 1.c Reconcile the step-up MFA flow (issue #250).
#
# The realm JSON declares `browser-with-step-up` (top-level + 2 nested
# sub-flows + a `loa-2-config` authenticator config) and assigns it as
# the browserFlow + sets `attributes."acr.loa.map"`. On a fresh realm
# import these all land. On an EXISTING realm the import is a no-op
# (IGNORE_EXISTING — see 1.b above) and the API's
# IMPERSONATION_REQUIRE_ACR_2 boot check fires correctly but the route
# always 401s `acr_insufficient` because Keycloak has no flow that emits
# acr=2. This block reconstructs the flow on existing realms via the
# Authentication REST API so a deploy fix can land without wiping the KC
# database.
#
# Idempotent: every step checks current state first. If the flow already
# matches, nothing is touched. Failing partway through (e.g. half a
# sub-flow created) is recoverable by re-running — the existence check
# will see the partial flow and the script will skip; an operator must
# manually delete the partial flow from the Admin UI before re-running.
# That's an acceptable failure mode for a one-time provisioning step.
#
# Flow shape (mirrors KC 26 docs §"Creating a browser login flow with
# step-up mechanism"; reviewed against
# services/.../authentication/authenticators/conditional/ConditionalLoaAuthenticator.java
# at tag 26.6.1):
#
#   browser-with-step-up                     [topLevel basic-flow]
#     ├─ auth-cookie                         ALTERNATIVE
#     ├─ identity-provider-redirector        ALTERNATIVE
#     └─ browser-with-step-up forms          ALTERNATIVE      [sub-flow]
#         ├─ browser-with-step-up loa-1      CONDITIONAL      [sub-flow]
#         │   ├─ Conditional-LoA (loa-1-config: level=1, max=36000)  REQUIRED
#         │   └─ auth-username-password-form REQUIRED
#         └─ browser-with-step-up loa-2      CONDITIONAL      [sub-flow]
#             ├─ Conditional-LoA (loa-2-config: level=2, max=300)    REQUIRED
#             └─ auth-otp-form               REQUIRED   (userSetupAllowed=true)
#
# Why two CONDITIONAL wrappers and not "password REQUIRED + LoA-2 CONDITIONAL"?
# ConditionalLoaAuthenticator.matchCondition() short-circuits to TRUE when
#   currentAuthenticationLoa < Constants.MINIMUM_LOA  (i.e. -1 < 0)
# which is the case at the start of EVERY fresh authentication — the auth
# session has no LEVEL_OF_AUTHENTICATION note yet. With the old structure
# (password-as-sibling), that short-circuit meant the LoA-2 conditional
# fired on every login regardless of acr_values, routing every user
# straight to CONFIGURE_TOTP. The two-conditional pattern is the only one
# documented to give "MFA only when client asks for it": the LoA-1
# wrapper consumes the short-circuit (runs password, sets LoA=1), and the
# LoA-2 wrapper then evaluates `requestedLoa(-1) < configuredLoa(2)` and
# correctly skips OTP. Confirmed by KC docs:
# "the first configured subflow with the Conditional - Level Of
#  Authentication is always executed (regardless of the requested level)
#  as the user does not yet have any level."
KC_URL="$KC_URL" REALM="$REALM" ADMIN_TOKEN="$ADMIN_TOKEN" \
KC_REALM_DISPLAY_NAME="${KC_REALM_DISPLAY_NAME:-}" \
python3 <<'PY' || warn "step-up flow reconciliation hit an error — see trace above."
import json, os, sys, urllib.parse, urllib.request, urllib.error

KC = os.environ["KC_URL"]
REALM = os.environ["REALM"]
TOKEN = os.environ["ADMIN_TOKEN"]
# Optional. Drives the issuer label embedded in the otpauth:// URI when
# Keycloak generates the QR code for TOTP enrolment — KC reads
# `realm.displayName` (falling back to `realm.getName()` when empty),
# and the authenticator app shows that label as the account header
# (e.g. "givernance-dev: alice@example.org" vs "givernance-staging:
# alice@example.org"). Per-environment value lets operators tell which
# realm an enrolled credential was minted against. Set per-env in:
#   - dev      → .env (`KC_REALM_DISPLAY_NAME=givernance-dev`)
#   - staging  → .github/workflows/deploy-staging.yml (`givernance-staging`)
#   - prod     → deploy-production.yml when it lands (`givernance`)
DESIRED_DISPLAY_NAME = os.environ.get("KC_REALM_DISPLAY_NAME") or ""
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
FLOW_ALIAS = "browser-with-step-up"
FORMS_ALIAS = "browser-with-step-up forms"
LOA1_ALIAS = "browser-with-step-up loa-1"
LOA2_ALIAS = "browser-with-step-up loa-2"
LOA1_CONFIG_ALIAS = "loa-1-config"
LOA2_CONFIG_ALIAS = "loa-2-config"
# loa-1 (password sub-flow) max-age is intentionally long-ish (10h):
# it gates whether KC re-prompts for the password on a returning SSO
# session at acr_values=1. Setting this very low (e.g. 300s) would
# force a fresh password every 5 min on normal logins, breaking the
# session story for users whose KC SSO cookie is still alive. The
# step-up flow ignores it because `prompt=login` always invalidates
# the SSO short-circuit. Multi-agent review API-3 (PR #251) flagged
# the value as "functionally arbitrary" — it is, but only within the
# space of "longer than the typical KC SSO cookie lifetime"; bumping
# it shorter degrades UX without adding security.
LOA1_DESIRED = {"loa-condition-level": "1", "loa-max-age": "36000"}
# loa-2 (OTP sub-flow) max-age MUST stay aligned with
# STEP_UP_AUTH_TIME_WINDOW_SECONDS in the API's step-up validator —
# the API rejects auth_time older than 5 min, so giving KC a longer
# window would let stale auth_time pass at the API gate.
LOA2_DESIRED = {"loa-condition-level": "2", "loa-max-age": "300"}
# Map both LoA 1 and LoA 2 so KC emits a stable string ACR claim on
# both normal logins (acr="1") and step-up (acr="2"). Values are
# strings (NOT numbers) so KC's outbound `acr` claim is consistent
# across token paths — earlier numeric values caused some token-paths
# to emit `acr: 2` (number) while others emitted `acr: "2"` (string),
# which `validateStepUp` survives via `String(acrRaw)` but downstream
# RP introspection and audit consumers don't expect both shapes.
# Multi-agent review API-1 (PR #251).
ACR_LOA_MAP = '{"1": "1", "2": "2"}'

def call(method, path, body=None):
    # Percent-encode any space in flow / sub-flow alias path segments.
    # Python 3.9's http.client refuses URLs with raw spaces, and KC's flow
    # aliases legitimately contain them ("browser-with-step-up forms").
    # quote(safe="/") preserves the path delimiters while escaping the
    # space — same behaviour as `curl --url-encoded` would give us.
    safe_path = urllib.parse.quote(path, safe="/?&=:")
    url = f"{KC}{safe_path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=HEADERS)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return e.code, body

# Marker prefix lets `grep '\[step-up\]'` slice the step-up flow lines
# out of CI logs without matching unrelated KC sync output (multi-agent
# review Logs N-16, PR #251).
def log(msg): print(f"   [step-up] {msg}")

# 1. Realm attributes (acr.loa.map). Drives both directions of the
#    level ↔ acr translation.
status, realm = call("GET", f"/admin/realms/{REALM}")
if status != 200:
    log(f"could not GET realm — HTTP {status}; aborting step-up sync")
    sys.exit(0)
attrs = realm.get("attributes") or {}
realm_dirty = False
if attrs.get("acr.loa.map") != ACR_LOA_MAP:
    attrs["acr.loa.map"] = ACR_LOA_MAP
    realm["attributes"] = attrs
    realm_dirty = True
    log(f"Will set realm attribute acr.loa.map={ACR_LOA_MAP}.")
else:
    log("Realm attribute acr.loa.map already correct.")

# `displayName` drives the TOTP QR-code issuer label per environment.
# Empty string / unset leaves whatever's currently on the realm — same
# fall-through KC uses internally (it then renders the realm name).
if DESIRED_DISPLAY_NAME and realm.get("displayName") != DESIRED_DISPLAY_NAME:
    realm["displayName"] = DESIRED_DISPLAY_NAME
    realm_dirty = True
    log(f"Will set realm.displayName={DESIRED_DISPLAY_NAME!r} (TOTP QR issuer).")
elif DESIRED_DISPLAY_NAME:
    log(f"Realm.displayName already {DESIRED_DISPLAY_NAME!r}.")

if realm_dirty:
    s, _ = call("PUT", f"/admin/realms/{REALM}", realm)
    log(f"Realm attributes / displayName written (HTTP {s}).")

# 2. Detect a stale flow shape and rebuild from scratch. Without this,
#    a realm that imported the v1 flow (password as a REQUIRED sibling
#    of a single LoA-2 conditional) keeps the broken "OTP on every login"
#    behaviour after a sync-script-only upgrade. We can't surgically
#    reorder executions via the REST API (no execute-as-child move is
#    safe), so we delete the top-level flow and rebuild it.
def expected_shape_ok(execs):
    """Return True iff the executions list matches the new two-conditional shape.

    KC's /authentication/flows/{alias}/executions returns a flat list with
    `level` (depth) and `index` (sibling position). We assert the exact
    set of (depth, providerId|displayName) we expect — anything else, even
    a partial old shape, triggers a rebuild.
    """
    expected = {
        # (level, identifier)
        (0, "auth-cookie"),
        (0, "identity-provider-redirector"),
        (0, FORMS_ALIAS),
        (1, LOA1_ALIAS),
        (1, LOA2_ALIAS),
        (2, "conditional-level-of-authentication"),
        (2, "auth-username-password-form"),
        (2, "auth-otp-form"),
    }
    seen = set()
    for ex in execs:
        ident = ex.get("providerId") or ex.get("displayName") or ""
        seen.add((ex.get("level"), ident))
    # Old shape had auth-username-password-form at level 1 (sibling of
    # the LoA-2 conditional). The new shape has it at level 2 (inside
    # the LoA-1 conditional). Comparing both directions gives a clean
    # "matches" / "doesn't match" answer.
    if (1, "auth-username-password-form") in seen:
        return False  # legacy shape detected
    if LOA1_ALIAS not in {ident for _, ident in seen}:
        return False  # missing the LoA-1 wrapper
    # All expected nodes must be present. (Allow extra nodes — e.g. an
    # operator added a custom WebAuthn step — but rebuild if any of ours
    # are missing.)
    return expected.issubset(seen)

status, flows = call("GET", f"/admin/realms/{REALM}/authentication/flows")
existing = {f["alias"]: f for f in (flows or [])}

needs_build = True
if FLOW_ALIAS in existing:
    s, execs = call("GET", f"/admin/realms/{REALM}/authentication/flows/{FLOW_ALIAS}/executions")
    if s == 200 and isinstance(execs, list) and expected_shape_ok(execs):
        log(f"Flow '{FLOW_ALIAS}' already matches the expected two-conditional shape.")
        needs_build = False
    else:
        log(f"Flow '{FLOW_ALIAS}' exists but its shape is stale — rebuilding.")
        # If the realm currently uses this as the browserFlow, swap it
        # back to the built-in `browser` flow before deleting; KC refuses
        # to delete a flow that is bound as the realm's browserFlow.
        s2, realm_now = call("GET", f"/admin/realms/{REALM}")
        if s2 == 200 and realm_now.get("browserFlow") == FLOW_ALIAS:
            realm_now["browserFlow"] = "browser"
            s3, _ = call("PUT", f"/admin/realms/{REALM}", realm_now)
            log(f"  Temporarily reset realm.browserFlow to 'browser' to allow delete (HTTP {s3}).")
        # Delete the stale flow. KC cascades the delete to all child
        # executions, sub-flows, and authenticator-config rows linked to
        # this flow's executions.
        flow_id = existing[FLOW_ALIAS]["id"]
        s4, _ = call("DELETE", f"/admin/realms/{REALM}/authentication/flows/{flow_id}")
        log(f"  Deleted stale top-level flow id={flow_id} (HTTP {s4}).")

if needs_build:
    s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows", {
        "alias": FLOW_ALIAS,
        "description": "Browser flow with conditional step-up MFA (issue #250).",
        "providerId": "basic-flow",
        "topLevel": True,
        "builtIn": False,
    })
    log(f"Created top-level flow '{FLOW_ALIAS}' (HTTP {s}).")
    if s not in (200, 201):
        log("flow create failed — aborting step-up sync")
        sys.exit(0)

    # cookie + IdP redirector at the top level (will become ALTERNATIVE
    # via the requirement-PATCH walk below).
    for provider in ["auth-cookie", "identity-provider-redirector"]:
        s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows/{FLOW_ALIAS}/executions/execution",
                    {"provider": provider})
        if s not in (200, 201):
            log(f"  add {provider}: HTTP {s}")

    # forms sub-flow. `provider` is intentionally omitted: KC's
    # AuthenticationManagementResource.addExecutionFlow only consumes
    # `provider` when `type == "form-flow"`; for `basic-flow` it's ignored.
    s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows/{FLOW_ALIAS}/executions/flow", {
        "alias": FORMS_ALIAS,
        "type": "basic-flow",
        "description": "Two Conditional-LoA wrappers (LoA 1 → password, LoA 2 → OTP).",
    })
    log(f"  Created sub-flow '{FORMS_ALIAS}' (HTTP {s}).")

    # LoA-1 sub-flow (CONDITIONAL): condition + username/password.
    s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows/{FORMS_ALIAS}/executions/flow", {
        "alias": LOA1_ALIAS,
        "type": "basic-flow",
        "description": "Always fires on first auth (currentLoa=-1 < MINIMUM_LOA=0). Runs username/password and sets LoA=1.",
    })
    log(f"  Created sub-flow '{LOA1_ALIAS}' (HTTP {s}).")
    for provider in ["conditional-level-of-authentication", "auth-username-password-form"]:
        s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows/{LOA1_ALIAS}/executions/execution",
                    {"provider": provider})
        if s not in (200, 201):
            log(f"  add {provider} → {LOA1_ALIAS}: HTTP {s}")

    # LoA-2 sub-flow (CONDITIONAL): condition + OTP.
    s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows/{FORMS_ALIAS}/executions/flow", {
        "alias": LOA2_ALIAS,
        "type": "basic-flow",
        "description": "Fires only when client requested acr_values=2 (or claims.id_token.acr.values maps to 2). Skipped on normal LoA 1 logins.",
    })
    log(f"  Created sub-flow '{LOA2_ALIAS}' (HTTP {s}).")
    for provider in ["conditional-level-of-authentication", "auth-otp-form"]:
        s, _ = call("POST", f"/admin/realms/{REALM}/authentication/flows/{LOA2_ALIAS}/executions/execution",
                    {"provider": provider})
        if s not in (200, 201):
            log(f"  add {provider} → {LOA2_ALIAS}: HTTP {s}")

# 3. ALWAYS reconcile execution requirements + auth-otp-form userSetupAllowed.
#    Runs even when the shape was already correct — covers the case where a
#    realm import landed the right structure but a downstream tweak (e.g. an
#    operator opening the Admin UI) flipped a requirement.
#    Default requirement on POST is DISABLED, so this is mandatory after a
#    REST rebuild and a no-op when the shape is already correct.
targets_by_provider = {
    "auth-cookie": "ALTERNATIVE",
    "identity-provider-redirector": "ALTERNATIVE",
    "auth-username-password-form": "REQUIRED",
    "conditional-level-of-authentication": "REQUIRED",
    "auth-otp-form": "REQUIRED",
}
targets_by_alias = {
    FORMS_ALIAS: "ALTERNATIVE",
    LOA1_ALIAS: "CONDITIONAL",
    LOA2_ALIAS: "CONDITIONAL",
}
s, execs = call("GET", f"/admin/realms/{REALM}/authentication/flows/{FLOW_ALIAS}/executions")
if s == 200 and isinstance(execs, list):
    for ex in execs:
        tgt = (
            targets_by_provider.get(ex.get("providerId"))
            or targets_by_alias.get(ex.get("displayName"))
        )
        if tgt and ex.get("requirement") != tgt:
            # IMPORTANT: only mutate `requirement` on the PUT body. Adding
            # `userSetupAllowed` to the same payload has Keycloak 26 reply
            # 400 on OTP-form executions (the AuthenticationExecution-
            # InfoRepresentation parser rejects the combo). The OTP form's
            # userSetupAllowed lives in the realm-import JSON; on a
            # REST-rebuilt flow we set it via a follow-up PATCH below.
            ex["requirement"] = tgt
            key = ex.get("displayName") or ex.get("providerId")
            s2, _ = call("PUT", f"/admin/realms/{REALM}/authentication/flows/{FLOW_ALIAS}/executions", ex)
            log(f"  set {key} requirement={tgt} (HTTP {s2}).")

    # NOTE on lazy OTP enrolment (issue #250). The realm JSON sets
    # `userSetupAllowed: true` on the auth-otp-form execution. That field
    # is a JSON-import concept that the KC 26 Admin REST API will not
    # accept on its AuthenticationExecutionInfoRepresentation PUT (returns
    # 400 "Unrecognized field"), and there is no other endpoint that
    # toggles it on a built-in authenticator post-hoc. Crucially that
    # doesn't matter: DefaultAuthenticationFlow.processSingleFlowExecutionModel
    # (KC 26.6.1) gates self-enrolment on `factory.isUserSetupAllowed()`,
    # not on the execution model field — and OTPFormAuthenticatorFactory
    # hardcodes `isUserSetupAllowed() = true`. So a REST-rebuilt LoA-2
    # sub-flow self-enrols a user with no TOTP credential the same way a
    # JSON-imported one does. Verified manually: a step-up login as the
    # admin user (no TOTP yet) redirects to CONFIGURE_TOTP after the
    # password form, exactly as the realm-import path does.

# 4. ALWAYS reconcile both LoA configs. KC's realm-import sometimes fails
#    to resolve the `authenticatorConfig: "loa-2-config"` alias-by-string
#    link, leaving the conditional with no config (configuredLoa→null→0,
#    matches everyone). This block walks the executions and either
#    creates the missing config or updates the values to match desired.
status, execs = call("GET", f"/admin/realms/{REALM}/authentication/flows/{FLOW_ALIAS}/executions")
if status == 200 and isinstance(execs, list):
    # Pair each conditional-level-of-authentication execution with its
    # parent sub-flow alias so we know which level config to attach. The
    # /executions endpoint returns a flat list with `level` (depth); we
    # walk it in order, tracking the most recent sub-flow at each depth.
    parent_at_depth = {}
    for ex in execs:
        depth = ex.get("level", 0)
        if ex.get("authenticationFlow"):
            parent_at_depth[depth] = ex.get("displayName") or ""
            # A new sub-flow shadows any deeper-stale entries.
            for d in list(parent_at_depth):
                if d > depth:
                    del parent_at_depth[d]
            continue
        if ex.get("providerId") != "conditional-level-of-authentication":
            continue
        # Parent sub-flow alias is at depth-1 (the conditional itself is
        # at depth, its enclosing CONDITIONAL sub-flow is at depth-1).
        parent_alias = parent_at_depth.get(depth - 1) or ""
        if parent_alias == LOA1_ALIAS:
            desired, alias = LOA1_DESIRED, LOA1_CONFIG_ALIAS
        elif parent_alias == LOA2_ALIAS:
            desired, alias = LOA2_DESIRED, LOA2_CONFIG_ALIAS
        else:
            log(f"  skip conditional under unknown sub-flow '{parent_alias}'")
            continue
        current_cfg_id = ex.get("authenticationConfig")
        if not current_cfg_id:
            s, _ = call(
                "POST",
                f"/admin/realms/{REALM}/authentication/executions/{ex['id']}/config",
                {"alias": alias, "config": desired},
            )
            log(f"Attached missing {alias} to {parent_alias} (HTTP {s}).")
        else:
            s, current = call("GET", f"/admin/realms/{REALM}/authentication/config/{current_cfg_id}")
            if s == 200 and isinstance(current, dict):
                actual = current.get("config") or {}
                # Reconcile the alias too — KC silently appends a numeric
                # suffix on collision (e.g. "loa-2-config-2") if the alias
                # was changed mid-flight; this PUT restores it.
                if actual != desired or current.get("alias") != alias:
                    s2, _ = call(
                        "PUT",
                        f"/admin/realms/{REALM}/authentication/config/{current_cfg_id}",
                        {"alias": alias, "config": desired},
                    )
                    log(f"Reconciled {alias} on {parent_alias} (HTTP {s2}).")
                else:
                    log(f"{alias} on {parent_alias} already correct — no change.")

# 5. Set realm.browserFlow (re-set after any rebuild that swapped it back
#    to "browser").
status, realm = call("GET", f"/admin/realms/{REALM}")
if status == 200 and realm.get("browserFlow") != FLOW_ALIAS:
    realm["browserFlow"] = FLOW_ALIAS
    s, _ = call("PUT", f"/admin/realms/{REALM}", realm)
    log(f"Set realm.browserFlow = '{FLOW_ALIAS}' (HTTP {s}).")
elif status == 200:
    log(f"Realm browserFlow already '{FLOW_ALIAS}'.")
PY

# OTP enrolment is intentionally LAZY (issue #250). We don't pre-add
# `CONFIGURE_TOTP` to anyone — the `auth-otp-form` execution in the
# `browser-with-step-up loa-2` sub-flow has `userSetupAllowed: true`,
# so when a super-admin is bounced into step-up the first time and
# has no OTP credential, KC's OTP form transparently routes them
# through the enrolment screen, then continues the flow. This means
# normal logins (no acr_values=2 → conditional sub-flow skipped) are
# never disrupted, even for super-admin users who haven't enrolled.
# An earlier draft of this script forced CONFIGURE_TOTP onto the seed
# user proactively; reverted because it surprised existing operators
# at their next login regardless of whether they were impersonating.

# 2. Ensure the `organization` client scope is the single home for all
#    org-related claims (`org_id`, `role`, `organization` membership), then
#    attach it to `givernance-web` (default) and `admin-cli` (optional).
#    Keeping the wiring on the scope rather than per-client means every
#    client that opts into `organization` — including the admin-cli path
#    used by the smoke test — emits the same claims.
client_uuid=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients?clientId=$(urlencode "$CLIENT_ID")" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')

# 2.a Remove any client-level `org_id`, `role`, or `organization` mappers
#     left over from earlier versions of this script on `givernance-web`.
#     If both the client AND the scope emit a mapper with the same claim
#     name, Keycloak builds a token with duplicate claims — the second
#     mapper's value silently clobbers the first, which masks drift.
if [ -n "$client_uuid" ]; then
  client_mappers=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models")
  for legacy in org_id role organization; do
    legacy_id=$(printf '%s' "$client_mappers" | CLAIM="$legacy" python3 -c '
import json, os, sys
wanted = os.environ["CLAIM"]
for m in json.load(sys.stdin):
    if m.get("name") == wanted:
        print(m["id"])
        break
')
    if [ -n "$legacy_id" ]; then
      curl -sS -o /dev/null -w "client-mapper delete (${legacy}): HTTP %{http_code}\n" \
        -X DELETE "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models/${legacy_id}" \
        "${auth[@]}"
      log "Removed legacy client-level '${legacy}' mapper from '${CLIENT_ID}' (now lives on the organization scope)."
    fi
  done
else
  log "Client '${CLIENT_ID}' not found — skipping client-side mapper cleanup."
fi

# 2.b Ensure the `organization` client scope exists. Keycloak auto-creates
#     it when Organizations is enabled at first-import time, but a realm
#     imported with the flag off and flipped on later does NOT get the
#     scope auto-provisioned. Self-heal here.
org_scope_id=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/client-scopes" \
  | python3 -c '
import sys, json
for s in json.load(sys.stdin):
    if s.get("name") == "organization":
        print(s["id"])
        break
')
if [ -z "$org_scope_id" ]; then
  log "Client scope 'organization' not found — creating it."
  scope_resp=$(curl -sS -D - -o /dev/null \
    -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes" \
    "${auth[@]}" -H "Content-Type: application/json" -d '{
      "name":"organization",
      "protocol":"openid-connect",
      "description":"Keycloak 26 Organizations membership + Givernance org_id/role claims (ADR-016).",
      "attributes":{
        "include.in.token.scope":"true",
        "display.on.consent.screen":"false"
      }
    }')
  org_scope_id=$(printf '%s' "$scope_resp" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r\n' | awk -F/ '{print $NF}')
  if [ -z "$org_scope_id" ]; then
    warn "Failed to create 'organization' client scope — membership claim will not be emitted."
    exit 1
  fi
  log "Created 'organization' client scope (id=${org_scope_id})."
fi

# 2.c Reconcile mappers on the `organization` client scope to the target
#     config. Upsert pattern: create missing mappers; overwrite existing
#     ones with the desired config so drift (e.g., Keycloak's auto-created
#     minimal membership mapper) is corrected every run.
scope_mappers=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/client-scopes/${org_scope_id}/protocol-mappers/models")

reconcile_scope_mapper() {
  local mapper_name="$1"
  local desired_body="$2"
  local existing_id
  existing_id=$(printf '%s' "$scope_mappers" | NAME="$mapper_name" python3 -c '
import json, os, sys
wanted = os.environ["NAME"]
for m in json.load(sys.stdin):
    if m.get("name") == wanted:
        print(m["id"])
        break
')
  if [ -z "$existing_id" ]; then
    curl -sS -o /dev/null -w "scope-mapper create (${mapper_name}): HTTP %{http_code}\n" \
      -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes/${org_scope_id}/protocol-mappers/models" \
      "${auth[@]}" -H "Content-Type: application/json" -d "$desired_body"
    log "Added '${mapper_name}' mapper to 'organization' client scope."
  else
    body_with_id=$(printf '%s' "$desired_body" | ID="$existing_id" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
d["id"] = os.environ["ID"]
print(json.dumps(d))
')
    curl -sS -o /dev/null -w "scope-mapper update (${mapper_name}): HTTP %{http_code}\n" \
      -X PUT "${KC_URL}/admin/realms/${REALM}/client-scopes/${org_scope_id}/protocol-mappers/models/${existing_id}" \
      "${auth[@]}" -H "Content-Type: application/json" -d "$body_with_id"
    log "Reconciled '${mapper_name}' mapper on 'organization' client scope."
  fi
}

reconcile_scope_mapper "org_id" '{
  "name":"org_id",
  "protocol":"openid-connect",
  "protocolMapper":"oidc-usermodel-attribute-mapper",
  "consentRequired":false,
  "config":{
    "userinfo.token.claim":"true",
    "user.attribute":"org_id",
    "id.token.claim":"true",
    "access.token.claim":"true",
    "introspection.token.claim":"true",
    "claim.name":"org_id",
    "jsonType.label":"String"
  }
}'

reconcile_scope_mapper "role" '{
  "name":"role",
  "protocol":"openid-connect",
  "protocolMapper":"oidc-usermodel-attribute-mapper",
  "consentRequired":false,
  "config":{
    "userinfo.token.claim":"true",
    "user.attribute":"role",
    "id.token.claim":"true",
    "access.token.claim":"true",
    "introspection.token.claim":"true",
    "claim.name":"role",
    "jsonType.label":"String"
  }
}'

reconcile_scope_mapper "organization" '{
  "name":"organization",
  "protocol":"openid-connect",
  "protocolMapper":"oidc-organization-membership-mapper",
  "consentRequired":false,
  "config":{
    "id.token.claim":"true",
    "access.token.claim":"true",
    "userinfo.token.claim":"true",
    "introspection.token.claim":"true",
    "claim.name":"organization",
    "jsonType.label":"JSON",
    "multivalued":"true",
    "addOrganizationId":"true",
    "addOrganizationAttributes":"true"
  }
}'

# 2.d Ensure `givernance-web` has the mandatory default scopes attached.
#     `organization` — custom, carries org_id / role / membership claims.
#     `basic`        — built-in, carries the `sub` protocol mapper (added in
#                      Keycloak 26; realms imported under older Keycloak
#                      versions don't have it attached to hand-rolled clients
#                      like `givernance-web`, which strips `sub` from every
#                      token and breaks the web-app callback's JWT verifier).
basic_scope_id=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/client-scopes" \
  | python3 -c '
import sys, json
for s in json.load(sys.stdin):
    if s.get("name") == "basic":
        print(s["id"])
        break
')
  if [ -z "$basic_scope_id" ]; then
    log "Native scope 'basic' missing on realm '${REALM}' — creating (carries the OIDC \`sub\` mapper)."
    basic_create_resp=$(curl -sS -D - -o /dev/null \
      -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes" \
      "${auth[@]}" -H "Content-Type: application/json" -d '{
        "name":"basic",
        "protocol":"openid-connect",
        "description":"OpenID Connect scope for add-ons that should be on by default (sub, audience).",
        "attributes":{
          "include.in.token.scope":"false",
          "display.on.consent.screen":"false"
        }
      }')
    basic_scope_id=$(printf '%s' "$basic_create_resp" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r\n' | awk -F/ '{print $NF}')
    if [ -z "$basic_scope_id" ]; then
      warn "Failed to create 'basic' scope — \`sub\` will be missing from access tokens."
    else
      log "Created 'basic' client scope (id=${basic_scope_id})."
      curl -sS -o /dev/null -w "basic-mapper create (sub): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes/${basic_scope_id}/protocol-mappers/models" \
        "${auth[@]}" -H "Content-Type: application/json" -d '{
          "name":"sub",
          "protocol":"openid-connect",
          "protocolMapper":"oidc-sub-mapper",
          "consentRequired":false,
          "config":{
            "introspection.token.claim":"true",
            "access.token.claim":"true"
          }
        }'
      curl -sS -o /dev/null -w "basic-mapper create (audience resolve): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes/${basic_scope_id}/protocol-mappers/models" \
        "${auth[@]}" -H "Content-Type: application/json" -d '{
          "name":"audience resolve",
          "protocol":"openid-connect",
          "protocolMapper":"oidc-audience-resolve-mapper",
          "consentRequired":false,
          "config":{}
        }'
    fi
  fi

  # Look up `roles`, creating it if missing. Same root cause as `basic`:
  # `KC_IMPORT_STRATEGY=OVERWRITE_EXISTING` skips `setupClientScopes()` on
  # the re-import path, so the realm ends up without `roles`. Without it,
  # the access token has no `realm_access.roles` claim — the web RBAC
  # guard then fails to recognize realm roles like `super_admin`, hiding
  # the back-office and the org-management settings even for the seeded
  # platform super-admin.
  roles_scope_id=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/client-scopes" \
    | python3 -c '
import sys, json
for s in json.load(sys.stdin):
    if s.get("name") == "roles":
        print(s["id"])
        break
')
  if [ -z "$roles_scope_id" ]; then
    log "Native scope 'roles' missing on realm '${REALM}' — creating (carries realm/client role mappers)."
    roles_create_resp=$(curl -sS -D - -o /dev/null \
      -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes" \
      "${auth[@]}" -H "Content-Type: application/json" -d '{
        "name":"roles",
        "protocol":"openid-connect",
        "description":"OpenID Connect scope for add-ons that should be on by default (realm + client role memberships).",
        "attributes":{
          "include.in.token.scope":"false",
          "display.on.consent.screen":"true",
          "consent.screen.text":"${rolesScopeConsentText}"
        }
      }')
    roles_scope_id=$(printf '%s' "$roles_create_resp" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r\n' | awk -F/ '{print $NF}')
    if [ -z "$roles_scope_id" ]; then
      warn "Failed to create 'roles' scope — \`realm_access.roles\` will be missing from access tokens."
    else
      log "Created 'roles' client scope (id=${roles_scope_id})."
      curl -sS -o /dev/null -w "roles-mapper create (realm roles): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes/${roles_scope_id}/protocol-mappers/models" \
        "${auth[@]}" -H "Content-Type: application/json" -d '{
          "name":"realm roles",
          "protocol":"openid-connect",
          "protocolMapper":"oidc-usermodel-realm-role-mapper",
          "consentRequired":false,
          "config":{
            "user.attribute":"foo",
            "access.token.claim":"true",
            "claim.name":"realm_access.roles",
            "jsonType.label":"String",
            "multivalued":"true"
          }
        }'
      curl -sS -o /dev/null -w "roles-mapper create (client roles): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes/${roles_scope_id}/protocol-mappers/models" \
        "${auth[@]}" -H "Content-Type: application/json" -d '{
          "name":"client roles",
          "protocol":"openid-connect",
          "protocolMapper":"oidc-usermodel-client-role-mapper",
          "consentRequired":false,
          "config":{
            "user.attribute":"foo",
            "access.token.claim":"true",
            "claim.name":"resource_access.${client_id}.roles",
            "jsonType.label":"String",
            "multivalued":"true"
          }
        }'
      curl -sS -o /dev/null -w "roles-mapper create (audience resolve): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes/${roles_scope_id}/protocol-mappers/models" \
        "${auth[@]}" -H "Content-Type: application/json" -d '{
          "name":"audience resolve",
          "protocol":"openid-connect",
          "protocolMapper":"oidc-audience-resolve-mapper",
          "consentRequired":false,
          "config":{}
        }'
    fi
  fi

attach_default_scope() {
  local target_client_uuid="$1"
  local target_client_id="$2"
  local scope_name="$3"
  local scope_id="$4"
  if [ -z "$scope_id" ]; then
    warn "Scope '${scope_name}' not found on realm '${REALM}' — cannot attach to '${target_client_id}'."
    return
  fi
  local current
  current=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${target_client_uuid}/default-client-scopes")
  if printf '%s' "$current" | NAME="$scope_name" python3 -c '
import json, os, sys
wanted = os.environ["NAME"]
have = any(s.get("name") == wanted for s in json.load(sys.stdin))
sys.exit(0 if have else 1)
'; then
    log "Client '${target_client_id}' already has the ${scope_name} scope on default."
  else
    curl -sS -o /dev/null -w "client-scope attach (${target_client_id} default ${scope_name}): HTTP %{http_code}\n" \
      -X PUT "${KC_URL}/admin/realms/${REALM}/clients/${target_client_uuid}/default-client-scopes/${scope_id}" \
      "${auth[@]}"
    log "Added '${scope_name}' client scope to default on '${target_client_id}'."
  fi
}

if [ -n "$client_uuid" ]; then
  attach_default_scope "$client_uuid" "$CLIENT_ID" "organization" "$org_scope_id"
  attach_default_scope "$client_uuid" "$CLIENT_ID" "basic" "$basic_scope_id"
  attach_default_scope "$client_uuid" "$CLIENT_ID" "roles" "$roles_scope_id"
fi

# 2.e Attach the `organization` scope as OPTIONAL on `admin-cli`, and turn
#     off lightweight access tokens so the scope's mappers actually land in
#     the access token the smoke test inspects. Keycloak 26 ships admin-cli
#     with `client.use.lightweight.access.token.enabled=true` by default,
#     which strips every mapper-contributed claim from the access token.
admin_cli_uuid=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients?clientId=admin-cli" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
if [ -z "$admin_cli_uuid" ]; then
  warn "Built-in 'admin-cli' client not found on realm '${REALM}' — smoke test will be unable to request the organization scope."
else
  admin_cli_optional=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${admin_cli_uuid}/optional-client-scopes")
  if printf '%s' "$admin_cli_optional" | python3 -c '
import sys, json
have = any(s.get("name") == "organization" for s in json.load(sys.stdin))
sys.exit(0 if have else 1)
'; then
    log "Client 'admin-cli' already has the organization scope on optional."
  else
    curl -sS -o /dev/null -w 'client-scope attach (admin-cli optional): HTTP %{http_code}\n' \
      -X PUT "${KC_URL}/admin/realms/${REALM}/clients/${admin_cli_uuid}/optional-client-scopes/${org_scope_id}" \
      "${auth[@]}"
    log "Added 'organization' client scope to optional on 'admin-cli'."
  fi

  # Ensure the `basic` scope is attached as default on admin-cli so its
  # access tokens carry `sub`. Keycloak's realm import skips auto-attaching
  # default scopes to auto-bootstrapped clients when the realm JSON has a
  # non-empty `clientScopes` array — admin-cli ends up with no default
  # scopes at all and the smoke test fails on the missing `sub` claim.
  attach_default_scope "$admin_cli_uuid" "admin-cli" "basic" "$basic_scope_id"

  admin_cli_full=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${admin_cli_uuid}")
  lightweight_enabled=$(printf '%s' "$admin_cli_full" | python3 -c '
import json, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
print("yes" if attrs.get("client.use.lightweight.access.token.enabled") == "true" else "no")
')
  if [ "$lightweight_enabled" = "yes" ]; then
    patched_admin_cli=$(printf '%s' "$admin_cli_full" | python3 -c '
import json, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
attrs["client.use.lightweight.access.token.enabled"] = "false"
d["attributes"] = attrs
print(json.dumps(d))
')
    curl -sS -o /dev/null -w 'admin-cli lightweight off: HTTP %{http_code}\n' \
      -X PUT "${KC_URL}/admin/realms/${REALM}/clients/${admin_cli_uuid}" \
      "${auth[@]}" -H "Content-Type: application/json" -d "$patched_admin_cli"
    log "Disabled lightweight access tokens on 'admin-cli' (needed for smoke test to inspect claim set)."
  else
    log "Client 'admin-cli' already issues full access tokens."
  fi
fi

# 2.f Reconcile the `givernance-admin` service-account's `realm-management`
#     client roles. The backend uses this service account to call the
#     Keycloak Admin API when provisioning tenants. In Keycloak 26,
#     Organizations API writes (POST/DELETE /organizations) require the
#     `manage-realm` role — there's no dedicated `manage-organizations`
#     role in this KC build. Realms created before this config was added
#     won't have the role, and tenant creation fails with HTTP 403.
#
#     Yes, `manage-realm` is broad. Keycloak's fine-grained admin
#     permissions (FGAP, preview) would let us narrow it to the
#     organizations resource; wiring that up is a separate hardening
#     ticket. For dev / self-hosted realms the broader role is acceptable.
admin_client_uuid=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients?clientId=givernance-admin" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
realm_mgmt_uuid=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients?clientId=realm-management" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
if [ -z "$admin_client_uuid" ] || [ -z "$realm_mgmt_uuid" ]; then
  log "Skipping givernance-admin service-account role sync (admin_client_uuid='${admin_client_uuid}', realm_mgmt_uuid='${realm_mgmt_uuid}')."
else
  sa_user_id=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${admin_client_uuid}/service-account-user" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id",""))')
  if [ -z "$sa_user_id" ]; then
    warn "Service account for 'givernance-admin' not found — Admin API calls from the backend will fail with 403."
  else
    sa_current=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users/${sa_user_id}/role-mappings/clients/${realm_mgmt_uuid}")
    required_roles="manage-realm view-realm"
    for role_name in $required_roles; do
      already=$(printf '%s' "$sa_current" | ROLE="$role_name" python3 -c '
import json, os, sys
wanted = os.environ["ROLE"]
print("yes" if any(r.get("name") == wanted for r in json.load(sys.stdin)) else "no")
')
      if [ "$already" = "yes" ]; then
        log "Service account 'givernance-admin' already has realm-management role '${role_name}'."
        continue
      fi
      role_repr=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${realm_mgmt_uuid}/roles/${role_name}")
      role_id_check=$(printf '%s' "$role_repr" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("id",""))
except Exception:
    print("")
')
      if [ -z "$role_id_check" ]; then
        warn "realm-management role '${role_name}' not found on realm '${REALM}' — Keycloak build may differ from expectations."
        continue
      fi
      curl -sS -o /dev/null -w "sa-role assign (${role_name}): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/users/${sa_user_id}/role-mappings/clients/${realm_mgmt_uuid}" \
        "${auth[@]}" -H "Content-Type: application/json" -d "[${role_repr}]"
      log "Granted realm-management role '${role_name}' to service account 'givernance-admin'."
    done
  fi
fi

# 2.g Rotate the `givernance-admin` client secret to match the
#     `KEYCLOAK_ADMIN_CLIENT_SECRET` env var. The realm JSON ships a
#     placeholder secret (`ci-test-admin-secret-do-not-use-in-production`)
#     that's correct for local + CI but wrong for staging/prod, where the
#     API container authenticates with a per-environment value. Without
#     this rotation, every Admin API call from the backend 401s with
#     "Token endpoint returned 401" and silently kills the
#     accept-invitation / signup-verify flows that need to provision
#     Keycloak users (the 410 / 500 the route returns gives no breadcrumb
#     pointing here).
if [ -z "${admin_client_uuid:-}" ]; then
  log "Skipping admin client secret rotation (admin_client_uuid not resolved)."
elif [ -z "${KEYCLOAK_ADMIN_CLIENT_SECRET:-}" ]; then
  log "KEYCLOAK_ADMIN_CLIENT_SECRET unset — leaving 'givernance-admin' secret as imported."
else
  current_admin_client=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${admin_client_uuid}")
  current_secret=$(printf '%s' "$current_admin_client" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("secret",""))')
  if [ "$current_secret" = "$KEYCLOAK_ADMIN_CLIENT_SECRET" ]; then
    log "Client 'givernance-admin' secret already matches env."
  else
    patched_admin_client=$(printf '%s' "$current_admin_client" | KCSEC="$KEYCLOAK_ADMIN_CLIENT_SECRET" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
d["secret"] = os.environ["KCSEC"]
print(json.dumps(d))
')
    curl -sS -o /dev/null -w 'givernance-admin secret rotation: HTTP %{http_code}\n' \
      -X PUT "${KC_URL}/admin/realms/${REALM}/clients/${admin_client_uuid}" \
      "${auth[@]}" -H "Content-Type: application/json" -d "$patched_admin_client"
    log "Rotated 'givernance-admin' client secret to match KEYCLOAK_ADMIN_CLIENT_SECRET."
  fi
fi

# 3. Ensure the seed user has the org_id attribute set.
user_json=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users?username=$(urlencode "$SEED_USERNAME")&exact=true")
user_id=$(printf '%s' "$user_json" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
if [ -z "$user_id" ]; then
  log "Seed user '${SEED_USERNAME}' not found — skipping attribute sync."
else
  user_full=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users/${user_id}")
  needs_patch=$(printf '%s' "$user_full" | ORG_ID="$SEED_ORG_ID" ROLE="$SEED_USER_ROLE" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
org_vals = attrs.get("org_id") or []
role_vals = attrs.get("role") or []
org_ok = bool(org_vals) and org_vals[0] == os.environ["ORG_ID"]
role_ok = bool(role_vals) and role_vals[0] == os.environ["ROLE"]
print("no" if org_ok and role_ok else "yes")
')
  if [ "$needs_patch" = "yes" ]; then
    patch_body=$(printf '%s' "$user_full" | ORG_ID="$SEED_ORG_ID" ROLE="$SEED_USER_ROLE" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
attrs["org_id"] = [os.environ["ORG_ID"]]
attrs["role"] = [os.environ["ROLE"]]
d["attributes"] = attrs
print(json.dumps(d))
')
    curl -sS -o /dev/null -w 'user patch: HTTP %{http_code}\n' \
      -X PUT "${KC_URL}/admin/realms/${REALM}/users/${user_id}" \
      "${auth[@]}" -H "Content-Type: application/json" -d "$patch_body"
    log "Set org_id=${SEED_ORG_ID}, role=${SEED_USER_ROLE} on user '${SEED_USERNAME}'."
  else
    log "User '${SEED_USERNAME}' already has the expected org_id and role."
  fi

  # 4. Ensure the seed user has the expected realm roles (e.g. super_admin).
  current_roles=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users/${user_id}/role-mappings/realm")
  IFS=',' read -r -a desired_roles <<< "$SEED_REALM_ROLES"
  for role_name in "${desired_roles[@]}"; do
    role_name_trimmed=$(printf '%s' "$role_name" | tr -d '[:space:]')
    [ -z "$role_name_trimmed" ] && continue
    already_assigned=$(printf '%s' "$current_roles" | ROLE="$role_name_trimmed" python3 -c '
import json, os, sys
wanted = os.environ["ROLE"]
print("yes" if any(r.get("name") == wanted for r in json.load(sys.stdin)) else "no")
')
    if [ "$already_assigned" = "yes" ]; then
      log "User '${SEED_USERNAME}' already has realm role '${role_name_trimmed}'."
      continue
    fi
    role_repr=$(curl -sS -w '\n%{http_code}' "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/roles/${role_name_trimmed}")
    role_status=$(printf '%s' "$role_repr" | tail -n1)
    role_body=$(printf '%s' "$role_repr" | sed '$d')
    if [ "$role_status" != "200" ]; then
      log "Realm role '${role_name_trimmed}' not found (HTTP ${role_status}) — skipping."
      continue
    fi
    curl -sS -o /dev/null -w 'role assign: HTTP %{http_code}\n' \
      -X POST "${KC_URL}/admin/realms/${REALM}/users/${user_id}/role-mappings/realm" \
      "${auth[@]}" -H "Content-Type: application/json" -d "[${role_body}]"
    log "Assigned realm role '${role_name_trimmed}' to user '${SEED_USERNAME}'."
  done
fi

# 5. Reconcile Keycloak Organizations (Keycloak 26+, ADR-016 / issue #114).
#    - Platform Organization with alias `${SEED_ORG_ALIAS}` and attribute
#      `org_id=${SEED_ORG_ID}` exists; creates it if missing.
#    - Seed user is a member (UNMANAGED membership).
#    Organizations API 404s if the `organizationsEnabled` realm flag is off
#    (pre-26 realm or feature disabled). We skip silently only on that case;
#    401/403/5xx are fatal so a silently-broken realm doesn't pretend to be OK.
orgs_probe=$(curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations")
case "$orgs_probe" in
  200)
    ;;
  404|501)
    log "Organizations API returned HTTP ${orgs_probe} — skipping Organizations sync (realm is pre-26 or feature disabled)."
    exit 0
    ;;
  *)
    warn "Organizations API returned HTTP ${orgs_probe} — aborting to surface the underlying error."
    curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations" >&2 || true
    exit 1
    ;;
esac

  # 5.a Ensure the platform Organization exists (lookup by alias via ?search=).
  org_id_kc=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations?search=$(urlencode "$SEED_ORG_ALIAS")" \
    | ALIAS="$SEED_ORG_ALIAS" python3 -c '
import json, os, sys
wanted = os.environ["ALIAS"]
for o in json.load(sys.stdin):
    if o.get("alias") == wanted:
        print(o["id"])
        break
')
  if [ -z "$org_id_kc" ]; then
    create_resp=$(curl -sS -D - -o /dev/null \
      -X POST "${KC_URL}/admin/realms/${REALM}/organizations" \
      "${auth[@]}" -H "Content-Type: application/json" -d "{
        \"name\":\"${SEED_ORG_NAME}\",
        \"alias\":\"${SEED_ORG_ALIAS}\",
        \"description\":\"Seeded platform organization (ADR-016 / issue #114).\",
        \"attributes\":{\"org_id\":[\"${SEED_ORG_ID}\"]},
        \"domains\":[{\"name\":\"${SEED_ORG_DOMAIN}\",\"verified\":true}]
      }")
    # Extract org id from Location header: .../organizations/<uuid>
    org_id_kc=$(printf '%s' "$create_resp" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r\n' | awk -F/ '{print $NF}')
    if [ -z "$org_id_kc" ]; then
      # Fallback: some reverse proxies strip the Location header. Re-query by alias.
      org_id_kc=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations?search=$(urlencode "$SEED_ORG_ALIAS")" \
        | ALIAS="$SEED_ORG_ALIAS" python3 -c '
import json, os, sys
wanted = os.environ["ALIAS"]
for o in json.load(sys.stdin):
    if o.get("alias") == wanted:
        print(o["id"])
        break
')
    fi
    if [ -z "$org_id_kc" ]; then
      warn "Organization create returned no Location header and re-query by alias found nothing — aborting."
      printf '   create response headers:\n%s\n' "$create_resp" >&2
      exit 1
    fi
    log "Created platform Organization '${SEED_ORG_ALIAS}' (id=${org_id_kc})."
  else
    # Reconcile attributes on existing org so org_id stays canonical.
    existing_org=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations/${org_id_kc}")
    attrs_ok=$(printf '%s' "$existing_org" | ORG_ID="$SEED_ORG_ID" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
org_vals = attrs.get("org_id") or []
print("yes" if bool(org_vals) and org_vals[0] == os.environ["ORG_ID"] else "no")
')
    if [ "$attrs_ok" = "yes" ]; then
      log "Platform Organization '${SEED_ORG_ALIAS}' already has the expected org_id attribute."
    else
      patched_org=$(printf '%s' "$existing_org" | ORG_ID="$SEED_ORG_ID" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
attrs = d.get("attributes") or {}
attrs["org_id"] = [os.environ["ORG_ID"]]
d["attributes"] = attrs
print(json.dumps(d))
')
      curl -sS -o /dev/null -w 'org patch: HTTP %{http_code}\n' \
        -X PUT "${KC_URL}/admin/realms/${REALM}/organizations/${org_id_kc}" \
        "${auth[@]}" -H "Content-Type: application/json" -d "$patched_org"
      log "Patched platform Organization '${SEED_ORG_ALIAS}' attributes.org_id=${SEED_ORG_ID}."
    fi
  fi

  # 5.b Ensure the "demo-asso" dev-only Organization exists when running on
  #     localhost. This org is intentionally absent from realm-givernance.json
  #     (which is deployed to all environments) so staging/production realms
  #     stay clean. The localhost guard means the sync script creates it
  #     automatically for local dev without any extra steps.
  DEMO_ORG_ALIAS="demo-asso"
  DEMO_ORG_ID="00000000-0000-0000-0000-0000000000a2"
  DEMO_ORG_NAME="Association D\u00e9mo"
  DEMO_ORG_DOMAIN="demo-asso.givernance.invalid"
  DEMO_ORG_PRIMARY_COLOR="#1a56db"

  _is_localhost() {
    local raw="${KC_URL##http://}"
    raw="${raw##https://}"
    local host="${raw%%:*}"
    host="${host%%/*}"
    case "$host" in
      localhost|127.0.0.1|::1) return 0 ;;
      *) return 1 ;;
    esac
  }

  if _is_localhost; then
    demo_org_kc_id=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations?search=$(urlencode "$DEMO_ORG_ALIAS")" \
      | ALIAS="$DEMO_ORG_ALIAS" python3 -c '
import json, os, sys
wanted = os.environ["ALIAS"]
for o in json.load(sys.stdin):
    if o.get("alias") == wanted:
        print(o["id"])
        break
')
    if [ -z "$demo_org_kc_id" ]; then
      curl -sS -D - -o /dev/null \
        -X POST "${KC_URL}/admin/realms/${REALM}/organizations" \
        "${auth[@]}" -H "Content-Type: application/json" \
        -d "{
          \"name\":\"${DEMO_ORG_NAME}\",
          \"alias\":\"${DEMO_ORG_ALIAS}\",
          \"description\":\"Dev-only fixture organization (multi-tenant demo). Never synced to staging/production.\",
          \"attributes\":{
            \"org_id\":[\"${DEMO_ORG_ID}\"],
            \"theme_primary_color\":[\"${DEMO_ORG_PRIMARY_COLOR}\"]
          },
          \"domains\":[{\"name\":\"${DEMO_ORG_DOMAIN}\",\"verified\":true}]
        }" | head -5
      log "Created dev-only '${DEMO_ORG_ALIAS}' Organization."
    else
      log "Dev org '${DEMO_ORG_ALIAS}' already exists (id=${demo_org_kc_id}) — no change."
    fi
  else
    log "Not on localhost — skipping dev-only '${DEMO_ORG_ALIAS}' Organization."
  fi

  # 5.d Ensure the seed user is a member of the platform Organization. We must
  #     re-resolve user_id outside the section-3 conditional (it was scoped
  #     there) so this section runs independently.
  member_user_id=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users?username=$(urlencode "$SEED_USERNAME")&exact=true" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
  if [ -z "$member_user_id" ] || [ -z "$org_id_kc" ]; then
    log "Skipping Organization membership (user_id='${member_user_id}', org_id_kc='${org_id_kc}')."
  else
    members=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/organizations/${org_id_kc}/members")
    is_member=$(printf '%s' "$members" | USER_ID="$member_user_id" python3 -c '
import json, os, sys
wanted = os.environ["USER_ID"]
print("yes" if any(m.get("id") == wanted for m in json.load(sys.stdin)) else "no")
')
    if [ "$is_member" = "yes" ]; then
      log "User '${SEED_USERNAME}' is already a member of '${SEED_ORG_ALIAS}'."
    else
      # Keycloak 26 Organizations membership endpoint: POST the user id as the
      # raw request body (JSON string). See OrganizationMemberResource.addMember.
      curl -sS -o /dev/null -w 'org member add: HTTP %{http_code}\n' \
        -X POST "${KC_URL}/admin/realms/${REALM}/organizations/${org_id_kc}/members" \
        "${auth[@]}" -H "Content-Type: application/json" -d "\"${member_user_id}\""
      log "Added user '${SEED_USERNAME}' as member of '${SEED_ORG_ALIAS}'."
    fi
  fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Configure Keycloak realm SMTP so password-reset emails can be sent.
#
#    resetPasswordAllowed is now true in realm-givernance.json (and reconciled
#    by section 1.b above). Without SMTP the KC "Forgot password?" flow shows
#    a generic error immediately after the user submits the reset form — the
#    realm has no MTA to deliver the token.
#
#    Configuration is driven by env vars so each environment supplies its own
#    mail backend without touching the realm JSON:
#
#      Local dev  →  KC_SMTP_HOST=mailpit  KC_SMTP_PORT=1025  (no auth, no TLS)
#                    Mailpit is running in docker-compose and captures every mail
#                    at http://localhost:${MAILPIT_HTTP_PORT:-8025}.
#      Staging    →  KC_SMTP_HOST=smtp.resend.com  KC_SMTP_PORT=587
#                    KC_SMTP_AUTH=true  KC_SMTP_STARTTLS=true
#                    KC_SMTP_USERNAME=resend  KC_SMTP_PASSWORD=<RESEND_API_KEY>
#                    Resend is already the app worker's email backend (issue #190).
#                    Using the same API key for KC keeps the secret surface small.
#
#    The section is idempotent: it reads the current smtpServer from the realm,
#    compares it to the desired state, and only calls PUT when a field differs.
#    When KC_SMTP_HOST is unset the section is skipped entirely (allows running
#    the sync script in read-only environments where email is not needed).
# ─────────────────────────────────────────────────────────────────────────────

if [ -z "${KC_SMTP_HOST:-}" ]; then
  log "KC_SMTP_HOST not set — skipping SMTP configuration (password-reset emails will not work until configured)."
else
  log "Reconciling realm SMTP configuration (host=${KC_SMTP_HOST}, port=${KC_SMTP_PORT:-25})..."

  current_realm_for_smtp=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}")

  smtp_patch=$(printf '%s' "$current_realm_for_smtp" | \
    KC_SMTP_HOST="${KC_SMTP_HOST}" \
    KC_SMTP_PORT="${KC_SMTP_PORT:-25}" \
    KC_SMTP_FROM="${KC_SMTP_FROM:-noreply@givernance.org}" \
    KC_SMTP_FROM_DISPLAY_NAME="${KC_SMTP_FROM_DISPLAY_NAME:-Givernance}" \
    KC_SMTP_REPLY_TO="${KC_SMTP_REPLY_TO:-}" \
    KC_SMTP_SSL="${KC_SMTP_SSL:-false}" \
    KC_SMTP_STARTTLS="${KC_SMTP_STARTTLS:-false}" \
    KC_SMTP_AUTH="${KC_SMTP_AUTH:-false}" \
    KC_SMTP_USERNAME="${KC_SMTP_USERNAME:-}" \
    KC_SMTP_PASSWORD="${KC_SMTP_PASSWORD:-}" \
    python3 -c '
import json, os, sys

d = json.load(sys.stdin)
desired = {
    "host":            os.environ["KC_SMTP_HOST"],
    "port":            os.environ["KC_SMTP_PORT"],
    "from":            os.environ["KC_SMTP_FROM"],
    "fromDisplayName": os.environ["KC_SMTP_FROM_DISPLAY_NAME"],
    "replyTo":         os.environ["KC_SMTP_REPLY_TO"],
    "ssl":             os.environ["KC_SMTP_SSL"],
    "starttls":        os.environ["KC_SMTP_STARTTLS"],
    "auth":            os.environ["KC_SMTP_AUTH"],
    "user":            os.environ["KC_SMTP_USERNAME"],
    "password":        os.environ["KC_SMTP_PASSWORD"],
}
# Strip empty optional fields to avoid sending empty strings to KC
desired = {k: v for k, v in desired.items() if v != "" or k in ("host", "port", "from")}

current = d.get("smtpServer") or {}
# Compare only the keys we manage (ignore KC-internal extras like "envelopeFrom")
needs_update = any(current.get(k) != v for k, v in desired.items())
if needs_update:
    d["smtpServer"] = {**current, **desired}
    print(json.dumps({"update": True, "realm": d}))
else:
    print(json.dumps({"update": False}))
')

  smtp_needs_update=$(printf '%s' "$smtp_patch" | python3 -c 'import json,sys; print(json.load(sys.stdin)["update"])')
  if [ "$smtp_needs_update" = "True" ]; then
    new_realm_smtp=$(printf '%s' "$smtp_patch" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["realm"]))')
    curl -sS -o /dev/null -w 'realm smtp update: HTTP %{http_code}\n' \
      -X PUT "${KC_URL}/admin/realms/${REALM}" \
      "${auth[@]}" -H "Content-Type: application/json" -d "$new_realm_smtp"
    log "SMTP configured on realm '${REALM}' (host=${KC_SMTP_HOST}:${KC_SMTP_PORT:-25})."
  else
    log "Realm SMTP already matches desired config — no change."
  fi
fi
