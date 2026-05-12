# Runbook — Override `backchannel.logout.url` per environment (issue #76 / PR-2)

> Operator-facing reference for keeping the OIDC back-channel logout webhook pointed at the correct hostname after a deploy. Applies to **staging** and **production**. Local dev is unaffected — `realm-givernance.json` already carries the right value (`http://api:3000/...`).

## Why this runbook exists

The `givernance-web` client in `infra/keycloak/realm-givernance.json` ships with a dev-shaped value:

```json
"backchannel.logout.url": "http://api:3000/v1/session/backchannel-logout"
```

Keycloak resolves that URL **from inside its own container** to find the API container — fine in `docker-compose`, useless outside it. Staging Keycloak (Scaleway VM) needs `https://staging.givernance.org/v1/session/backchannel-logout`; production Keycloak needs `https://app.givernance.org/v1/session/backchannel-logout`.

`scripts/keycloak-sync-realm.sh` reconciles the realm config from the JSON on every run. **Unless you set the override after each reconcile, the prod URL will silently revert to `http://api:3000/...`** — Keycloak will then POST into a black hole on every legitimate session-end signal, and operators will only notice when a "Sign out all sessions" admin action fails to propagate.

## When to run this runbook

- After a fresh deploy / re-import of the realm JSON
- After `keycloak-sync-realm.sh` ran (CI deploy, manual reconcile)
- After rotating to a new Keycloak instance (DR drill, region migration)
- As part of the post-deploy smoke check on every PR that touches `realm-givernance.json`

## Steps — staging

```bash
# 1. Get a Keycloak admin access token using the service-account client
ADMIN_TOKEN=$(curl -s -X POST \
  "https://auth-staging.givernance.org/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=$KC_ADMIN_USER" \
  -d "password=$KC_ADMIN_PASSWORD" | jq -r .access_token)

# 2. Resolve the givernance-web client UUID (one-time per realm)
CLIENT_UUID=$(curl -s \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://auth-staging.givernance.org/admin/realms/givernance/clients?clientId=givernance-web" \
  | jq -r '.[0].id')

# 3. Read the current attributes so we don't clobber other overrides
CURRENT=$(curl -s \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://auth-staging.givernance.org/admin/realms/givernance/clients/$CLIENT_UUID")

# 4. Patch backchannel.logout.url in-place, leaving every other attribute alone
echo "$CURRENT" | jq '
  .attributes."backchannel.logout.url" = "https://staging.givernance.org/v1/session/backchannel-logout"
' | curl -s -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "https://auth-staging.givernance.org/admin/realms/givernance/clients/$CLIENT_UUID"

# 5. Verify
curl -s \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://auth-staging.givernance.org/admin/realms/givernance/clients/$CLIENT_UUID" \
  | jq '.attributes."backchannel.logout.url"'
# Expected: "https://staging.givernance.org/v1/session/backchannel-logout"
```

## Steps — production

Identical to staging, but swap:

| Token | Replace with |
|---|---|
| `https://auth-staging.givernance.org` | `https://auth.givernance.org` |
| `https://staging.givernance.org/...` | `https://app.givernance.org/...` |

## Smoke test the override

```bash
# 1. Tail the API logs in one pane
ssh givernance-staging "docker logs -f givernance-api 2>&1 | grep backchannel-logout"

# 2. In another pane: log in to staging Givernance with a test account,
#    then end the session from the Keycloak admin console (Users → select
#    user → Sessions → Sign out all sessions).

# 3. The API should log a line like:
#    {"sid":"...", "subHash":"...", "jti":"...", "msg":"backchannel-logout: sid blocklisted"}
#    within ~1s of the admin action.

# 4. Within the same browser tab on the test account, navigate to any
#    protected page. The next API call should 401 with "Session revoked."
#    and middleware should redirect to /login.
```

If step 3 never fires, the override didn't stick — re-check step 5 above, then look at the Keycloak admin console for "Admin events" / "Login events" with type `LOGOUT_ERROR` (Keycloak's signal that the back-channel POST failed).

## What to do if you broke it

- **URL points at the wrong host (e.g., dev hostname in prod)**: re-run the steps above with the right hostname. No data loss; Keycloak will just resume hitting the right URL on the next session end.
- **You overwrote other attributes (forgot the merge in step 4)**: pull the canonical client config from `realm-givernance.json` and re-apply via `PUT /admin/realms/{realm}/clients/{uuid}`. Then re-apply the `backchannel.logout.url` override.
- **The override isn't taking effect**: confirm the realm name matches (`givernance`), the client UUID is correct, and there's no per-environment Keycloak sync workflow running on a schedule that re-imports the JSON behind your back.

## Future automation

The right fix is to make `scripts/keycloak-sync-realm.sh` env-substitute `backchannel.logout.url` based on a `KC_BACKCHANNEL_LOGOUT_URL` env var (parallel to `${APP_URL}` substitution if/when that's introduced). Tracked as the only outstanding follow-up after PR #360 — until then, this runbook is the contract.
