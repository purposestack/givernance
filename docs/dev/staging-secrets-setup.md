# Setting up the staging GitHub Environment secret bag

Reference for fork developers and for the production-launch runbook ([`docs/runbooks/launch-prod.md`](../runbooks/launch-prod.md)).

> **Why this exists.** [`.github/actions/setup-kamal-secrets/action.yml`](../../.github/actions/setup-kamal-secrets/action.yml) is the single source of truth for the secret bag every staging deploy + accessory reboot consumes (`deploy-staging.yml`, `staging-accessory-reboot.yml`, `migrate-staging-postgres.yml`). Until #340/#343 it had `:-staging_X_123` fallbacks committed in plaintext for every secret, which were load-bearing in practice and showed up in container envs ([#340](https://github.com/purposestack/givernance/issues/340) audit). Since #343 (2026-05-10) the action requires every secret listed below; missing any one fails the deploy at the `Setup Kamal Secrets` step with a clear error pointing here.

## Required secrets

Set every entry in **Settings → Environments → staging → Environment secrets** (NOT repo-level secrets, NOT environment variables).

| Secret name | Generate via | Used by | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | bootstrap-superuser pw for the postgres accessory; runtime auth for `DATABASE_URL` (used for migrations + legitimate cross-tenant ops only — never application reads) | Hex is the recommended charset (URL-safe by construction). #335 fix makes other charsets work via percent-encoding, but hex stays simpler. |
| `GIVERNANCE_APP_PASSWORD` | `openssl rand -hex 24` | application role `givernance_app` (NOBYPASSRLS) used by api + worker via `DATABASE_URL_APP` | **Required (issue #430).** Before #430 this was missing and `DATABASE_URL_APP` silently fell back to the owner role, bypassing RLS across the stack. To rotate on a running cluster: see [`docs/runbooks/cross-tenant-rls-hardening-cutover.md`](../runbooks/cross-tenant-rls-hardening-cutover.md). |
| `REDIS_PASSWORD` | `openssl rand -hex 24` | `redis-server --requirepass` (via `infra/redis/start.sh`) AND apps' `REDIS_URL` | Same charset reasoning. |
| `KEYCLOAK_DB_PASSWORD` | `openssl rand -hex 24` | dedicated `keycloak` role (#336) — KC connects to its own database with this | Set this BEFORE running the staging Keycloak DB cutover runbook on a fresh cluster. Bootstrap-superuser path: the postgres accessory's init script (`infra/postgres/init/01-init-keycloak-db.sh`) provisions the role + `givernance_keycloak` DB on first cluster boot. |
| `KEYCLOAK_ADMIN_PASSWORD` | `openssl rand -hex 24` | KC master-realm admin user. **Important:** KC reads this only on first realm bootstrap; after that, the admin user's password is stored inside KC and ignores the env. To rotate later: `kcadm.sh set-password` on the running KC, THEN update the GH secret + reboot the accessory (so the env matches if a future fresh-init happens). | |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | `openssl rand -hex 32` | `givernance-admin` confidential client in the `givernance` realm — used by the api for tenant-onboarding admin operations | `scripts/keycloak-sync-realm.sh` (called as the deploy's "Sync Keycloak realm" step) reconciles the realm-side value from this env on every deploy. |
| `SEAWEEDFS_S3_SECRET_KEY` | `openssl rand -hex 24` | SeaweedFS S3 secret-access-key — the S3 secret used by apps AND the SeaweedFS `admin` identity. Apps connect via `S3_ACCESS_KEY_ID=admin` + `S3_SECRET_ACCESS_KEY=$SEAWEEDFS_S3_SECRET_KEY`. To rotate: reboot the seaweedfs accessory (it picks up the new env on container restart), then redeploy apps so their S3_SECRET_ACCESS_KEY env matches. See [ADR-034](../adrs/adr-034-seaweedfs-over-minio-for-self-hosted-object-storage.md). | |
| `SEAWEEDFS_SSE_KEY` | `openssl rand -hex 32` | SeaweedFS SSE-S3 KEK passphrase — apps upload PDF receipts with `ServerSideEncryption: AES256`; SeaweedFS HKDF-derives the AES-256 KEK from this passphrase (`WEED_S3_SSE_KEY`). | **No length constraint** — HKDF accepts any-length passphrase. See [ADR-034](../adrs/adr-034-seaweedfs-over-minio-for-self-hosted-object-storage.md). |
| `SESSION_SECRET` | `openssl rand -hex 32` | Next.js session cookie signing | Rotation invalidates all live sessions (everyone gets logged out). |
| `IMPERSONATION_JWT_SECRET` | `openssl rand -hex 32` | Symmetric HS256 secret signing the api's app-layer impersonation JWTs (and the web SSR's verification of them — issue #24) | Production env check in `packages/api/src/env.ts` requires this to be present and ≥32 chars on boot. |
| `RESEND_API_KEY` | from Resend dashboard | Worker email sender (transactional sends — signup verification, team invitations) | Set as the dedicated staging Resend API key (scoped to the verified `givernance.org` apex). |
| `STRIPE_SECRET_KEY` | from Stripe dashboard | api Stripe Connect platform key | Empty allowed — surfaces "Stripe is not configured" UX message instead of crashing. See [`docs/dev/stripe-local-setup.md`](stripe-local-setup.md) → Staging deployment. |
| `STRIPE_WEBHOOK_SECRET` | from Stripe dashboard webhook config | api Stripe webhook signature verification | Empty allowed (same reasoning as STRIPE_SECRET_KEY). |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | from Stripe dashboard | Web Stripe.js init (baked into Next.js bundle at build time via `builder.args`) | Empty allowed. **Resolved at workflow level** in `deploy-staging.yml`'s root `env:` block, NOT in this composite action — but listed here for completeness because operators shouldn't have to chase it. |
| `VPS_IP` | Scaleway console | Kamal config's ERB template (`STAGING_VPS_IP`); also exported to runner env for `ssh -L` style operator commands | One-time set per VPS provisioning. |
| `SSH_PRIVATE_KEY` | dedicated key generated by operator (NOT personal) | webfactory/ssh-agent in every staging-touching workflow | Recommended: rotate at every operator-team change. |

> **Total: 16 entries** — 13 application/infra secrets + 3 deploy-time identifiers (`VPS_IP`, `SSH_PRIVATE_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`).

## Bulk-setup recipe

For a fresh staging environment (or a fork), run something like this from a local checkout (assumes `gh` CLI authenticated against your fork):

```bash
# 1. Generate every secret (URL-safe hex by default).
declare -A SECRETS=(
  [POSTGRES_PASSWORD]="$(openssl rand -hex 24)"
  [GIVERNANCE_APP_PASSWORD]="$(openssl rand -hex 24)"
  [REDIS_PASSWORD]="$(openssl rand -hex 24)"
  [KEYCLOAK_DB_PASSWORD]="$(openssl rand -hex 24)"
  [KEYCLOAK_ADMIN_PASSWORD]="$(openssl rand -hex 24)"
  [KEYCLOAK_ADMIN_CLIENT_SECRET]="$(openssl rand -hex 32)"
  [SEAWEEDFS_S3_SECRET_KEY]="$(openssl rand -hex 24)"
  [SEAWEEDFS_SSE_KEY]="$(openssl rand -hex 32)"
  [SESSION_SECRET]="$(openssl rand -hex 32)"
  [IMPERSONATION_JWT_SECRET]="$(openssl rand -hex 32)"
)

# 2. Print them all so you can save to your password manager BEFORE setting them in GH.
#    (The `gh secret set` step below makes them write-only — you can't read them back from GH.)
for k in "${(@k)SECRETS}"; do
  printf '%-30s %s\n' "$k" "${SECRETS[$k]}"
done
echo
read -k '?Saved every value to 1Password (or your secret manager)? Press any key to continue, Ctrl-C to abort: '
echo

# 3. Set each in the staging GH Environment.
for k in "${(@k)SECRETS}"; do
  printf '%s' "${SECRETS[$k]}" | gh secret set "$k" --env staging --repo <your-org>/<your-fork>
done

# 4. Set the externally-sourced ones manually (Stripe / Resend / VPS / SSH key).
gh secret set STRIPE_SECRET_KEY --env staging --repo <your-org>/<your-fork>          # paste from Stripe dashboard
gh secret set STRIPE_WEBHOOK_SECRET --env staging --repo <your-org>/<your-fork>     # paste from Stripe dashboard
gh secret set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY --env staging --repo <your-org>/<your-fork>
gh secret set RESEND_API_KEY --env staging --repo <your-org>/<your-fork>            # paste from Resend dashboard
gh secret set VPS_IP --env staging --repo <your-org>/<your-fork>                    # the staging VPS public IP
gh secret set SSH_PRIVATE_KEY --env staging --repo <your-org>/<your-fork>           # paste your dedicated staging key

# 5. Sanity-check.
gh secret list --env staging --repo <your-org>/<your-fork> | sort

# 6. Clear the in-memory map.
unset SECRETS
```

> The above is zsh syntax (associative arrays). For bash 4+ replace `${(@k)SECRETS}` with `${!SECRETS[@]}` and `read -k '?…'` with `read -p '…' -n 1`.

## How rotations work

Each secret has a different rotation procedure depending on whether the running service caches it post-startup. See the runbooks under `docs/runbooks/` for per-secret recipes — the [`migrate-staging-keycloak-db.md`](../runbooks/migrate-staging-keycloak-db.md) journal documents the patterns that emerged during the 2026-05-10 audit.

Quick reference:

| Secret | What "rotation" needs |
|---|---|
| `POSTGRES_PASSWORD` | `ALTER ROLE givernance WITH PASSWORD 'new'` on the live cluster (auth as the role first), THEN `gh secret set`, THEN `gh workflow run deploy-staging.yml -f mode=deploy`. The postgres container's env stays stale until the accessory itself is rebooted (which doesn't happen on plain `kamal deploy`); that's fine because POSTGRES_PASSWORD is only used at first init. |
| `GIVERNANCE_APP_PASSWORD` | `ALTER ROLE givernance_app WITH PASSWORD 'new'` on the live cluster, THEN `gh secret set`, THEN `gh workflow run deploy-staging.yml -f mode=deploy`. The boot-time `assertAppRoleSecure` guard crash-loops the container if `DATABASE_URL_APP` connects as a BYPASSRLS role, so a misrotation fails the deploy fast (no silent leak). See [`docs/runbooks/cross-tenant-rls-hardening-cutover.md`](../runbooks/cross-tenant-rls-hardening-cutover.md). |
| `REDIS_PASSWORD` | `gh secret set`, then `gh workflow run deploy-staging.yml -f mode=deploy`, then `gh workflow run staging-accessory-reboot.yml -f accessory=redis -f confirm=redis`. Redis rebooted with the new env picks up `requirepass` from the bag (via `infra/redis/start.sh`). |
| `KEYCLOAK_ADMIN_PASSWORD` | `kcadm.sh set-password -r master --username admin --new-password '<new>'` on the running KC (auth with the OLD password first), THEN `gh secret set`, THEN reboot keycloak accessory (cosmetic — KC ignores the env post-bootstrap). |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | `gh secret set`, then `gh workflow run deploy-staging.yml -f mode=deploy`. The deploy's "Sync Keycloak realm" step calls `scripts/keycloak-sync-realm.sh` which reconciles the realm-side value from env. |
| `SEAWEEDFS_S3_SECRET_KEY` | `gh secret set`, then reboot seaweedfs accessory (picks up new env on restart), then deploy mode=deploy (apps' S3_SECRET_ACCESS_KEY env updates). |
| `SESSION_SECRET` / `IMPERSONATION_JWT_SECRET` | `gh secret set`, then `gh workflow run deploy-staging.yml -f mode=deploy`. Side effect: existing sessions / impersonation tokens invalidated. |

## Anti-patterns to avoid

- **Don't** set these as **repo-level** secrets — `deploy-staging.yml` declares `environment: staging` and only resolves env-scoped secrets.
- **Don't** set them as GH **Variables** — they need to be marked as Secrets so they're masked in workflow logs.
- **Don't** reuse the same value across staging and production. Generate per-environment.
- **Don't** revert to the `staging_X_123` strings that lived in the action's fallbacks pre-#343 — those values are still in the git history and are public.
