# Givernance — Infrastructure

This document describes the local development stack and the SaaS production architecture.

## Local Development

The local stack mirrors the SaaS production services using Docker Compose.

### Prerequisites

- Docker Engine 24+ with Compose V2
- Node.js 22 LTS
- pnpm 9+

### Quick Start

```bash
# Copy environment file
cp .env.example .env

# Start all services
./scripts/dev-up.sh

# Stop all services
./scripts/dev-down.sh
```

Or manually:

```bash
docker compose up -d
```

#### Upgrading from a pre-ADR-017 checkout

If you already have a `pgdata` volume from before the Keycloak DB split (ADR-017), the init script in `infra/postgres/init/` will **not** run — the Postgres image only executes `/docker-entrypoint-initdb.d/*` on an empty data directory. You'll see Keycloak start up and fail to connect to `givernance_keycloak`, and `./scripts/dev-up.sh` now fails fast with a pointer back to this section rather than hanging on the readiness probe. Reset the local volumes once:

```bash
docker compose down -v   # wipes pgdata, redisdata, miniodata, mailpitdata
./scripts/dev-up.sh      # recreates everything, including givernance_keycloak
```

This is safe in dev because **all state is reproducible from fixtures and migrations**: Keycloak realm state is rebuilt from [`infra/keycloak/realm-givernance.json`](../../infra/keycloak/realm-givernance.json) and then reconciled idempotently by [`scripts/keycloak-sync-realm.sh`](../../scripts/keycloak-sync-realm.sh), and the app DB is rebuilt by `pnpm db:migrate` and (optionally) `pnpm --filter @givernance/api run db:seed`. **Don't run `down -v` against a volume you've customised manually** (hand-added realm users, hand-edited rows, test tenants you care about) — it wipes the lot. Dump what you need first with `docker compose exec postgres pg_dump …`.

### Local Services

| Service | URL | Purpose |
|---------|-----|---------|
| PostgreSQL 16 | `localhost:5432` | Shared instance hosting the `givernance` and `givernance_keycloak` databases — see [Databases](#databases) |
| Redis 7 | `localhost:6379` | Cache, rate limiting |
| Keycloak 24 | `http://localhost:8080` | OIDC/SAML identity provider (admin: `admin`/`admin`) |
| MinIO | `http://localhost:9000` (API), `http://localhost:9001` (Console) | S3-compatible object storage (user: `givernance`/`givernance_dev`) |
| Mailpit | `localhost:1025` (SMTP), `http://localhost:8025` (UI) | Local email capture and testing |
| Caddy | `localhost:3000`, `localhost:3001` | Reverse proxy (optional, `--profile proxy`) |

### Databases

Per [ADR-017](../15-infra-adr.md#adr-017-one-logical-database-per-tool--isolate-keycloak-from-the-application-db), the local Postgres 16 instance hosts **one logical database per tool**. Adding a new tool that needs Postgres storage is an explicit decision: it gets its own database and its own owner role — never a shared one.

| Database | Owner role | Used by | Initialised by |
|---|---|---|---|
| `givernance` | `givernance` | Givernance API (Drizzle-managed `public` schema), Worker, Outbox relay | `POSTGRES_DB` / `POSTGRES_USER` on the postgres service (native image bootstrap) |
| `givernance_keycloak` | `keycloak` | Keycloak 24 — entire Keycloak schema (`realm`, `user_entity`, `client`, `credential`, …) | `infra/postgres/init/01-init-keycloak-db.sh`, on first `docker compose up -d` against a fresh `pgdata` volume |
| `givernance_test` | `givernance` | API integration tests only | `scripts/dev-up.sh` on each start (created if missing, migrated fresh) |

The app role that the API uses at runtime (`givernance_app`, NOBYPASSRLS) is provisioned by the Drizzle migrations inside the `givernance` database — see §6 of [`docs/02-reference-architecture.md`](../02-reference-architecture.md) for the 3-role RLS pattern.

### Recommended Local Tooling (macOS Apple Silicon)

| Tool | Purpose | Download |
|------|---------|---------|
| [Beekeeper Studio](https://www.beekeeperstudio.io/) | SQL client — browse and query PostgreSQL | [Download .dmg (arm64)](https://www.beekeeperstudio.io/download/?ext=dmg&arch=arm64&type=&edition=community) |
| [RedisInsight](https://redis.io/insight/) | Redis GUI — inspect keys, streams, BullMQ queues | [Download .dmg (arm64)](https://github.com/redis/RedisInsight/releases/download/3.2.0/Redis-Insight-mac-arm64.dmg) |

**Beekeeper Studio** — connect to the local PostgreSQL instance:
- Host: `localhost`, Port: `5432`
- App database: `givernance`, User: `givernance`, Password: `givernance_dev`
- Keycloak database (rarely needed — prefer the Keycloak admin console): `givernance_keycloak`, User: `keycloak`, Password: `keycloak_dev` — or connect as the `givernance` superuser to inspect both DBs.

**RedisInsight** — connect to the local Redis instance:
- Host: `localhost`, Port: `6379`

---

### Connecting the App

The application reads connection strings from environment variables. See `.env.example` for defaults:

```
DATABASE_URL=postgresql://givernance:givernance_dev@localhost:5432/givernance
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
SMTP_HOST=localhost
SMTP_PORT=1025
```

---

## Running the Application Locally

`./scripts/dev-up.sh` already installs dependencies, runs migrations on both the app and test DBs, reconciles the Keycloak realm, and — **if the fixture tenant has no constituents yet** — seeds a demo tenant (`givernance`, UUID `00000000-0000-0000-0000-0000000000a1`) with 50 constituents, 5 campaigns, and 100 donations. Re-running the script after the seed is in place will skip seeding (the script is safe to invoke repeatedly).

So the happy path is:

```bash
./scripts/dev-up.sh   # one command: infra + migrations + seed (first time) + realm sync
pnpm dev              # start all workspace dev servers in parallel
```

To force a fresh seed (e.g. after schema churn), wipe volumes first:

```bash
docker compose down -v && ./scripts/dev-up.sh
```

Manual equivalents if you're running Compose directly (`docker compose up -d` instead of `dev-up.sh`):

```bash
pnpm install
pnpm db:migrate
pnpm --filter @givernance/api run db:seed   # one-shot; re-runs append, so only run on empty DB
```

You should see the web on `http://localhost:3000`, the API on `http://localhost:4000`, plus worker and outbox relay processes.

### Logging in

1. Navigate to `http://localhost:3000` → redirects to Keycloak
2. Credentials (pre-seeded in `infra/keycloak/realm-givernance.json`):
   - **Email**: `admin@givernance.org`
   - **Password**: `admin`
3. You land on `/dashboard`; `/constituents` shows the seeded donors

### Keycloak JWT verification

The web now stores the raw Keycloak access token in `givernance_jwt`. Both the Next.js server guards and the Fastify API verify that token against the realm JWKS (`KEYCLOAK_JWKS_URL`) and enforce the configured issuer (`KEYCLOAK_ISSUER`).

The seeded realm also ships an `org_id` protocol mapper on the `givernance-web` client (and an `unmanagedAttributePolicy=ENABLED` user profile so Keycloak 24 accepts the `org_id` attribute). It reads the Keycloak user attribute `org_id` and injects it into access and ID tokens. Existing realms are not updated by `--import-realm`; `scripts/dev-up.sh` reconciles them automatically via `scripts/keycloak-sync-realm.sh`, which you can also invoke directly.

### Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `GET /v1/constituents` → `ECONNREFUSED` from the web | Node's fetch races `::1` (IPv6) against `127.0.0.1` for `localhost`; the API binds IPv4-only. `.env` already pins `API_URL=http://127.0.0.1:4000` — don't change it back to `localhost`. |
| `ERR_TOO_MANY_REDIRECTS` on `/dashboard` after login | Stale or invalid auth cookies. Delete `givernance_jwt` / `givernance_id_token` in DevTools → Application → Cookies, then log in again. |
| Login redirects back to `/login?error=missing_org_id` | The Keycloak access token was valid but did not contain `org_id`. Run `./scripts/keycloak-sync-realm.sh` to reconcile the live realm with the expected mapper + user attribute, then log in again. |
| Web starts on port 4000 instead of 3000 (`EADDRINUSE`) | `.env` sets `PORT=4000` for the API; `dotenv-cli` forwards it. The web `dev` script already passes `-p 3000` to override. |
| `/constituents` shows empty state despite seed running | The Keycloak user's `org_id` attribute does not match the seeded tenant UUID. Set it to `00000000-0000-0000-0000-0000000000a1` or re-run the seed and re-login. |
| Keycloak logs `FATAL: password authentication failed for user "keycloak"` after editing `.env` | Both the `postgres` and `keycloak` services read `KEYCLOAK_DB_*` from host env at container-create time. If you `export KEYCLOAK_DB_PASSWORD=…` in your shell **after** `docker compose up -d` has already provisioned the volume, postgres keeps the old hash while keycloak starts connecting with the new password. Fix: `docker compose down -v && docker compose up -d` (or `ALTER ROLE keycloak WITH PASSWORD …` inside the postgres container) so the two sides agree again. |

> **Secrets in dev-only env:** `docker inspect postgres` prints every value from `KEYCLOAK_DB_PASSWORD`, `POSTGRES_PASSWORD`, etc. in plaintext — these are the `ci-test-*` / `*_dev` defaults committed in `.env.example` and are intentional for local dev. Production (Scaleway / self-hosted) must inject these via a secret manager (Scaleway secret manager + Kamal secrets, or your self-hosted equivalent) and never via a committed `.env`.

---

## SaaS Architecture (Scaleway EU)

The managed SaaS offering runs entirely on **Scaleway**, a French cloud provider with datacenters in Paris (PAR) and Amsterdam (AMS). All infrastructure is under a **single Scaleway GDPR Data Processing Agreement (DPA)** — 100% EU data residency.

See [ADR-009](../15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider) for the full decision record.

### Managed Services

| Component | Scaleway Product | Local Equivalent |
|-----------|-----------------|------------------|
| Database | Managed PostgreSQL EU (PAR/AMS) | PostgreSQL 16 (Docker) |
| Cache / Rate Limiting | Managed Redis EU | Redis 7 (Docker) |
| Object Storage | Scaleway Object Storage (S3-compatible) | MinIO (Docker) |
| Auth | Keycloak on Scaleway VM | Keycloak (Docker) |
| Observability | Cockpit (Grafana + Loki + Mimir + Tempo) | — (local: stdout logs) |
| AI Inference | Scaleway Generative APIs (Mistral, Llama 3.1) | — (optional, not in local stack) |
| Deployment | Kamal + Scaleway EU VMs | Docker Compose |

### GDPR Compliance

- **Data residency**: All data stored and processed in EU (France / Netherlands).
- **Single DPA**: One contract with Scaleway covers compute, database, storage, cache, inference, and observability.
- **Art. 9 special category data**: Beneficiary case notes and medical/social status processed via Scaleway Generative APIs — EU-only inference, no data leaves EU jurisdiction.
- **Self-hosted option**: NPOs requiring on-premises deployment use the same Docker Compose stack with their own PostgreSQL, Redis, MinIO, and Keycloak instances.

### Cost Estimates

| Phase | Config | Monthly Cost |
|-------|--------|-------------|
| Phase 0 (dev/staging) | Minimal VMs + managed DB | ~67 EUR |
| Phase 1 (1 NPO pilot) | API x2, Worker, Web, DB + replica, Redis, Keycloak HA | ~281 EUR |
| Phase 1 extended (5-10 NPOs) | Scaled Phase 1 | ~458 EUR |

---

## Self-Hosted Deployment

For NPOs that need on-premises infrastructure, the same Docker Compose file serves as the deployment baseline:

```
PostgreSQL 16 + PgBouncer
Redis 7
MinIO (S3-compatible storage)
Keycloak 24 (OIDC/SAML)
Caddy (reverse proxy + TLS)
```

Production self-hosted deployments should add:
- TLS certificates (Caddy handles automatic HTTPS via Let's Encrypt)
- Database backups (pg_dump cron or WAL archiving)
- Redis persistence configuration
- MinIO replication for storage durability

---

## Troubleshooting

### Keycloak Admin Console: "HTTPS required"

Keycloak 24 defaults to `ssl_required=EXTERNAL` on the `master` realm. In local dev (`start-dev` mode), this can trigger an "HTTPS required" error when accessing `http://localhost:8080` — especially if your browser has cached an HSTS header for `localhost` from a previous project.

**The `dev-up.sh` script handles this automatically** by setting `ssl_required=NONE` on the master realm after first boot.

If you still see the error, it's likely your browser's HSTS cache. To clear it:

- **Chrome**: Navigate to `chrome://net-internals/#hsts`, enter `localhost` under "Delete domain security policies", and click Delete.
- **Firefox**: Close all tabs to `localhost`, then clear your recent history (Ctrl+Shift+Delete) with only "Active Logins" and "Site Settings" checked.
- **Quick workaround**: Open the Keycloak admin console in an **Incognito/Private window**.
