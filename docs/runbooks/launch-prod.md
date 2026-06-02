# Runbook — Launch the Givernance production environment

> Tracking issue: [#344](https://github.com/purposestack/givernance/issues/344). Captures every hygiene lesson from the 2026-05-10 staging audit (#340) so prod doesn't reproduce them. Filled in as a journal during the actual launch (same pattern as [`migrate-staging-keycloak-db.md`](migrate-staging-keycloak-db.md)).
>
> **One-shot.** Runs once, when the production environment is provisioned for the first time. Subsequent rotations / image bumps / migrations get their own per-task runbooks (or extend this one's "Day 2" section).
>
> **What this runbook delivers.** A staging-equivalent cluster on prod hardware (Scaleway VM + Managed PostgreSQL or self-hosted PG depending on Phase 1 vs Phase 4+ posture per [ADR-009](../adrs/adr-009-…)) with: every secret rotated off committed defaults from day 1; every infra service kamal-network-only (no public 0.0.0.0:* listeners); Redis enforcing `requirepass`; ADR-017 DB topology in place from the start (no separate keycloak-DB cutover needed because we boot fresh); auth on `auth.givernance.org`; the app on `givernance.org` / `app.givernance.org`.
>
> **What this runbook does NOT cover.** Stripe live-mode onboarding (separate runbook, blocking on the Connect platform setup ADR); per-tenant onboarding (driven by the in-app signup flow, not infra); the SaaS marketing site at `givernance.org/{en,fr}/marketing`. Out of scope here.

---

## Plan (forward)

```
                                    Day 0 — Provision                                       Day 1 — Launch
   ┌──────────────────────────┐                                              ┌───────────────────────────────┐
   │ Operator local           │                                              │ Operator local                │
   │  - generate every secret │                                              │  - dispatch deploy-prod.yml   │
   │  - save to 1Password     │                                              │  - watch first kamal setup    │
   │  - populate GH `prod` env│   GH `prod` Environment secret bag full      │  - run smoke + first-login    │
   └──────────────────────────┘                                              └───────────────┬───────────────┘
                                                                                             │
                                                                                             ▼
                                                                ┌──────────────────────────────────────────┐
                                                                │ Scaleway prod VM                         │
                                                                │  - kamal-proxy (HTTPS via Let's Encrypt) │
                                                                │  - postgres (kamal-network-only)         │
                                                                │  - redis (kamal-network-only, requirepass│
                                                                │  - seaweedfs (kamal-network-only)        │
                                                                │  - keycloak (proxied; givernance_keycloak│
                                                                │    DB from day 1 via init script)        │
                                                                │  - api / web / worker / relay            │
                                                                └──────────────────────────────────────────┘
                                                                Public listeners on the host: 22 / 80 / 443
                                                                Everything else on the kamal Docker network.
```

### Pre-flight checklist (Day 0 — before the deploy workflow ever fires)

- [ ] **VPS provisioned**: Scaleway VM in PAR (Paris) or AMS (Amsterdam) per ADR-009. Sized per `docs/infra/README.md` Phase 1 cost estimates.
- [ ] **DNS records added** at the registrar pointing to the VPS public IP:
  - [ ] `givernance.org` (web)
  - [ ] `app.givernance.org` (web — same VHost, separated for tenant-app traffic)
  - [ ] `api.givernance.org` (api via kamal-proxy)
  - [ ] `auth.givernance.org` (keycloak via kamal-proxy)
- [ ] **Scaleway security group** on the prod VM allows inbound only on:
  - `22/tcp` — SSH; consider IP allowlist for operator team + GH Actions runner ranges (the latter is harder to pin reliably; use a dedicated bastion instead if feasible)
  - `80/tcp` — HTTP (only for kamal-proxy ACME challenges; kamal-proxy auto-redirects to 443)
  - `443/tcp` — HTTPS
  - **Explicitly deny** `5432`, `6379`, `8080`, `8333`. Belt-and-suspenders alongside the kamal-network-only configuration in `config/deploy-prod.yml` (when it lands; same shape as staging post-#341).
- [ ] **SSH dedicated key** generated locally (NOT operator personal key). Save private key to 1Password vault `Givernance · Production` → item `SSH key (deploy)`. Public key added to the VM's `~/.ssh/authorized_keys` for the deploy user.
- [ ] **`config/deploy-prod.yml` exists** in the repo, mirroring the structure of `config/deploy-staging.yml` post-#341 (no `port:` mapping on any infra accessory, redis uses `infra/redis/start.sh`, postgres mounts the `01-init-keycloak-db.sh` init script via `files:`). DNS hostnames swapped for prod values. Image references same as staging unless explicitly version-pinned per Scaleway's compliance ceiling (see `infra/compliance-versions.yml` + ADR-026).
- [ ] **`production` GH Environment created** (`Settings → Environments → New environment → production`). Recommended: required-reviewer protection (the operator team), branch policy `Selected branches → main`.
- [ ] **Every secret listed in `docs/dev/staging-secrets-setup.md` is set in the `production` GH Environment** with freshly-generated values (DO NOT reuse staging values). Use the bulk-setup script there with `--env production` instead of `--env staging`.
- [ ] **`deploy-prod.yml` workflow exists** (mirror of `deploy-staging.yml`, swapping `staging` → `production` for environment + secrets refs). Wired into `setup-kamal-secrets` composite action — which is required-secrets-only since #343, so a missing `production` secret fails the deploy at the `Setup Kamal Secrets` step with a clear error.
- [ ] **Coordination**: announce launch window in the team channel. Estimate ~1 hour for the initial deploy + smoke; subsequent ops are fast.

### Day 1 — Launch sequence

#### Step 1 — Trigger the first prod deploy

```bash
# From a checkout of main with all the prerequisites above met.
gh workflow run deploy-prod.yml --ref main --repo purposestack/givernance -f mode=setup
sleep 8
RUN_ID=$(gh run list --repo purposestack/givernance --workflow=deploy-prod.yml --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch --repo purposestack/givernance --exit-status "$RUN_ID"
```

The first run uses `mode=setup` (full kamal bootstrap), not the routine `mode=deploy`. This:
- Sets up kamal-proxy on the VM with TLS via Let's Encrypt (auto-acquires certs for the four DNS names above on first start)
- Boots all four accessories (postgres, redis, seaweedfs, keycloak) — postgres's first init runs `infra/postgres/init/01-init-keycloak-db.sh`, provisioning the dedicated `keycloak` role + `givernance_keycloak` DB AND hardening the public schema in both databases
- Builds and pushes the keycloak image
- Builds and pushes the app image
- Boots the api / web / worker / relay containers
- Runs DB migrations
- Runs DB seed (the seed for prod should be a no-op or minimal — TBD per the seed script's prod handling; verify in advance)
- Reconciles the Keycloak realm via `scripts/keycloak-sync-realm.sh`

> **If the deploy fails partway through:** the `Dump Keycloak logs on failure` and `Dump API logs on failure` steps surface logs to the run summary. Most likely failure modes on a first run: a missing GH secret (now fail-fast with a clear error since #343), a DNS record not yet propagated (rerun once propagation completes), a Scaleway-firewall rule blocking 80/443.

#### Step 2 — Smoke

```bash
curl -fsSI https://api.givernance.org/healthz
curl -fsSI https://auth.givernance.org/realms/givernance/.well-known/openid-configuration
curl -fsSI https://givernance.org/
curl -fsSI https://app.givernance.org/login
```

All four should return 200 (or 200/302 for the web hostnames depending on the locale-redirect logic).

#### Step 3 — First admin login

```bash
# Open in incognito to avoid caching from staging:
open "https://app.givernance.org/login"
# Sign in as the seeded admin user; credentials match what the realm-import created.
# If the seed didn't create one, use the master-realm admin (KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD)
# to log into https://auth.givernance.org/admin/master/console/ and create the first user manually.
```

#### Step 4 — Confirm DB topology is ADR-017 compliant from the start

```bash
ssh givernance-prod "docker exec -e PGPASSWORD='<POSTGRES_PASSWORD from 1Password>' givernance-postgres psql -U givernance -d postgres -tAc \"SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname IN ('givernance', 'givernance_keycloak') ORDER BY datname\""
# Expected:
#   givernance|givernance
#   givernance_keycloak|keycloak
```

(Note: prod DB name is `givernance`, not `givernance_staging`. Adjust if your `config/deploy-prod.yml` uses a different `POSTGRES_DB`.)

#### Step 5 — Confirm Redis enforces auth + no public ports

```bash
# Redis anonymous PING must FAIL (Redis container has --requirepass set via infra/redis/start.sh).
ssh givernance-prod "docker exec givernance-redis redis-cli PING 2>&1" || echo "  ✓ rejected"

# Authenticated PING must SUCCEED.
ssh givernance-prod "docker exec givernance-redis redis-cli -a '<REDIS_PASSWORD>' --no-auth-warning PING"

# No public ports beyond 22/80/443.
ssh givernance-prod "ss -tln | awk 'NR>1 {print \$4}' | sort -u"
# Expected: only *:22, *:80, *:443 (plus the IPv6 [::]: variants).
```

#### Step 6 — Post-launch journal

Fill in the **Journal** section below with actual outcomes — same pattern as `docs/runbooks/migrate-staging-keycloak-db.md`. Commit the filled journal as part of the first prod-config PR (or directly to main if the launch was a single push).

---

## Day 2 onward

Once the cluster is alive, day-to-day ops parallel staging. Reuse:

- **Routine deploys**: `deploy-prod.yml` triggers on push to main + manual dispatch. Same `mode=auto/deploy/setup` semantics as staging.
- **Accessory reboots / rotations**: `prod-accessory-reboot.yml` (mirror of `staging-accessory-reboot.yml`).
- **Rotation runbooks**: every recipe in `docs/dev/staging-secrets-setup.md` "How rotations work" applies to prod with the obvious env-name swap. **Always rotate prod secrets independently of staging** — never reuse a value across environments.

### Recommended cadences

- `SESSION_SECRET` / `IMPERSONATION_JWT_SECRET`: rotate quarterly, or on any operator-team change.
- `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `KEYCLOAK_DB_PASSWORD`: rotate yearly, or on any infrastructure-team change.
- `KEYCLOAK_ADMIN_PASSWORD` / `KEYCLOAK_ADMIN_CLIENT_SECRET`: rotate on any operator-team change.
- `SEAWEEDFS_S3_SECRET_KEY`: rotate yearly. **Never** rotate the SSE-S3 KEK passphrase (`WEED_S3_SSE_KEY` / `SEAWEEDFS_SSE_KEY`) without a re-encryption migration — encrypted objects become unreadable otherwise.
- `SSH_PRIVATE_KEY`: rotate per the org's normal cadence.

---

## Journal (fill in during the launch)

| Field | Value |
|---|---|
| Operator | _____ |
| VPS provider / region | Scaleway / _____ |
| VPS public IP | _____ |
| Launch start (UTC) | _____ |
| Launch end (UTC) | _____ |
| Total operator-on-keyboard time | _____ |
| First `deploy-prod.yml` run (run #) | _____ |
| `kamal setup` wall-clock | _____ s |
| First Let's Encrypt cert acquisition | OK / fail (which DNS name first) |
| First admin login | OK / fail |
| ADR-017 DB topology check | givernance owner=_____ ; givernance_keycloak owner=_____ |
| Redis auth check (anonymous rejected) | OK / fail |
| Public port audit (only 22/80/443) | OK / fail |
| Deviations from plan | _____ |
| Decisions made on the fly | _____ |

## Post-mortem (fill in after launch — first 48 hours)

- [ ] All four public endpoints return 200 in continuous monitoring (api healthz, auth OIDC, web home, web /login)
- [ ] Sign-in flow works end-to-end (KC login → app dashboard → at least one DB-touching navigation)
- [ ] Stripe webhook signature verification works (test webhook from the Stripe dashboard)
- [ ] Receipt PDF generation works (create a test donation, verify PDF lands in SeaweedFS with SSE-S3 encryption)
- [ ] Worker email delivery works (send a test invitation, verify receipt via Resend dashboard)
- [ ] Logs flow into Scaleway Cockpit (Loki ingest + Grafana panels)
- [ ] First nightly DB backup completes (Scaleway Managed PG handles this if applicable; otherwise verify your `pg_dump` cron)

### What went well

_____

### What went wrong / surprised us

_____

### Follow-up items

- [ ] _____

---

## Related

- [`docs/runbooks/migrate-staging-keycloak-db.md`](migrate-staging-keycloak-db.md) — the staging Keycloak DB cutover (issue #283). Doesn't apply to prod (we boot ADR-017 compliant from day 1) but the journal/post-mortem structure is the model.
- [`docs/dev/staging-secrets-setup.md`](../dev/staging-secrets-setup.md) — secret bag reference (works for prod too with the obvious env swap).
- [`docs/infra/README.md`](../infra/README.md) — infrastructure topology (Scaleway services, sizing, GDPR posture).
- [`docs/15-infra-adr.md`](../15-infra-adr.md) — Architecture Decision Records, esp. ADR-009 (Scaleway), ADR-017 (one DB per tool), ADR-023 (PG 17 cutover policy).
- [`config/deploy-staging.yml`](../../config/deploy-staging.yml) — template for `config/deploy-prod.yml`. Diff between them after launch should be minimal: hostname swaps, possibly different image pins per the compliance manifest, possibly different sizing flags on the VM accessories.
- Tracking issue: [#344](https://github.com/purposestack/givernance/issues/344).
