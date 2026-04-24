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
#   - Client `givernance-web`: `org_id`, `role`, and `organization` protocol mappers
#   - Client `givernance-web`: `organization` client scope on default scopes
#   - Client `admin-cli`:     `organization` client scope on optional scopes
#     (so the smoke test's RO-password grant can request the scope)
#   - Realm: `organization` client scope exists (KC creates it when
#     Organizations is enabled, but a realm upgraded from <26 or with the
#     flag toggled post-import may be missing it — we create it if so)
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

# 2. Ensure the givernance-web client has an `org_id` protocol mapper.
client_uuid=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients?clientId=$(urlencode "$CLIENT_ID")" \
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

  # 2.bis Ensure the `organization` protocol mapper (Keycloak 26 built-in,
  #       oidc-organization-membership-mapper) emits the org membership claim
  #       including org id + attributes. Read by the app as an alternative to
  #       the flat `org_id` user-attribute mapper (ADR-016 / issue #114).
  if printf '%s' "$mappers" | python3 -c '
import json, sys
have = any(m["name"] == "organization" for m in json.load(sys.stdin))
sys.exit(0 if have else 1)
'; then
    log "Client '${CLIENT_ID}' already has organization protocol mapper."
  else
    curl -sS -o /dev/null -w 'mapper create (organization): HTTP %{http_code}\n' \
      -X POST "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models" \
      "${auth[@]}" -H "Content-Type: application/json" -d '{
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
    log "Added organization protocol mapper to client '${CLIENT_ID}'."
  fi

  # 2.ter Ensure the `organization` client scope exists, then attach it:
  #       - as a DEFAULT scope on `givernance-web` (so every web-app token
  #         carries the membership claim without requesting it)
  #       - as an OPTIONAL scope on `admin-cli` (so the smoke test's RO
  #         password grant — which uses admin-cli — can request it)
  #
  #       Keycloak auto-creates the `organization` client scope when
  #       Organizations is enabled at first-import time. But a realm that was
  #       imported with the flag off and flipped on later does NOT get the
  #       scope auto-provisioned (keycloak-user list, 2025). We create it
  #       ourselves to make the script self-healing on partial upgrades.
  org_scope_json=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/client-scopes" \
    | python3 -c '
import sys, json
for s in json.load(sys.stdin):
    if s.get("name") == "organization":
        print(s["id"])
        break
')
  if [ -z "$org_scope_json" ]; then
    log "Client scope 'organization' not found — creating it."
    scope_resp=$(curl -sS -D - -o /dev/null \
      -X POST "${KC_URL}/admin/realms/${REALM}/client-scopes" \
      "${auth[@]}" -H "Content-Type: application/json" -d '{
        "name":"organization",
        "protocol":"openid-connect",
        "description":"Keycloak 26 Organizations membership claim (ADR-016)",
        "attributes":{
          "include.in.token.scope":"true",
          "display.on.consent.screen":"false"
        }
      }')
    org_scope_json=$(printf '%s' "$scope_resp" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r\n' | awk -F/ '{print $NF}')
    if [ -z "$org_scope_json" ]; then
      warn "Failed to create 'organization' client scope — membership claim will not be emitted."
      exit 1
    fi
    log "Created 'organization' client scope (id=${org_scope_json})."
  fi

  # Attach to `givernance-web` default scopes.
  default_scopes=$(curl -sS "${auth[@]}" "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/default-client-scopes")
  if printf '%s' "$default_scopes" | python3 -c '
import sys, json
have = any(s.get("name") == "organization" for s in json.load(sys.stdin))
sys.exit(0 if have else 1)
'; then
    log "Client '${CLIENT_ID}' already has the organization scope on default."
  else
    curl -sS -o /dev/null -w 'client-scope attach (web default): HTTP %{http_code}\n' \
      -X PUT "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/default-client-scopes/${org_scope_json}" \
      "${auth[@]}"
    log "Added 'organization' client scope to default on '${CLIENT_ID}'."
  fi

  # Attach to `admin-cli` optional scopes so the smoke test can request it.
  # Every realm has an admin-cli client; look it up and attach the scope as
  # OPTIONAL (not default — we don't want every admin-cli token to carry an
  # org claim unless explicitly requested).
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
        -X PUT "${KC_URL}/admin/realms/${REALM}/clients/${admin_cli_uuid}/optional-client-scopes/${org_scope_json}" \
        "${auth[@]}"
      log "Added 'organization' client scope to optional on 'admin-cli'."
    fi
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

  # 5.b Ensure the seed user is a member of the platform Organization. We must
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
