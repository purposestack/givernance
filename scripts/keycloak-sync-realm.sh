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
#   - Client `givernance-web`: `org_id` and `role` protocol mappers
#   - User `admin@givernance.org`: `org_id` and `role` attributes
#   - User `admin@givernance.org`: `super_admin` realm role assignment
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

log() { printf '   %s\n' "$*"; }

token_resp=$(curl -sS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN}&password=${KC_ADMIN_PASSWORD}")
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

# 2. Ensure the givernance-web client has an `org_id` protocol mapper.
client_uuid=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
if [ -z "$client_uuid" ]; then
  log "Client '${CLIENT_ID}' not found — skipping mapper sync."
else
  mappers=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models")
  for claim in org_id role; do
    if printf '%s' "$mappers" | CLAIM="$claim" python3 -c '
import json, os, sys
wanted = os.environ["CLAIM"]
have = any(m["name"] == wanted for m in json.load(sys.stdin))
sys.exit(0 if have else 1)
'; then
      log "Client '${CLIENT_ID}' already has ${claim} protocol mapper."
    else
      curl -sS -o /dev/null -w "mapper create (${claim}): HTTP %{http_code}\n" \
        -X POST "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models" \
        "${auth[@]}" -H "Content-Type: application/json" -d "{
          \"name\":\"${claim}\",
          \"protocol\":\"openid-connect\",
          \"protocolMapper\":\"oidc-usermodel-attribute-mapper\",
          \"consentRequired\":false,
          \"config\":{
            \"userinfo.token.claim\":\"true\",
            \"user.attribute\":\"${claim}\",
            \"id.token.claim\":\"true\",
            \"access.token.claim\":\"true\",
            \"claim.name\":\"${claim}\",
            \"jsonType.label\":\"String\"
          }
        }"
      log "Added ${claim} protocol mapper to client '${CLIENT_ID}'."
    fi
  done
fi

# 3. Ensure the seed user has the org_id attribute set.
user_json=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/users?username=${SEED_USERNAME}&exact=true")
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
