## ADR-017: One Logical Database per Tool — Isolate Keycloak from the Application DB

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: Magino (founder/architect)
- **Related**: [ADR-001](#adr-001-modular-monolith-over-microservices) (modular monolith, single app DB), [ADR-009](#adr-009--scaleway-as-primary-saas-managed-cloud-provider) (Scaleway managed PostgreSQL), [ADR-016](#adr-016-tenant-onboarding--multi-tenancy--hybrid-self-serve--enterprise-model) (names this ADR as a prerequisite for the Keycloak 26 / Organizations upgrade), issue [#61](https://github.com/purposestack/givernance/issues/61), issue [#114](https://github.com/purposestack/givernance/issues/114)

### Context

The Phase 1 `docker-compose.yml` provisioned a single Postgres 16 instance with a single logical database (`givernance`), and wired **both** the application and Keycloak at the same database URL. Concretely Keycloak 24 was started with `KC_DB_URL: jdbc:postgresql://postgres:5432/givernance`, which meant Keycloak's ~90 internal tables (`realm`, `user_entity`, `client`, `credential`, `…`) sat next to the Drizzle-managed application tables (`tenants`, `users`, `donations`, `audit_log`, `…`) in the same `public` schema.

The problems that surfaced:

- **Blast radius.** A bad restore, a mistaken `DROP SCHEMA public CASCADE`, or a Keycloak upgrade that altered its schema could touch application data (and vice versa). Backup/PITR could not scope either side independently.
- **Migration risk.** Drizzle's introspection and any `drizzle-kit push` saw Keycloak's tables as foreign objects. A Keycloak 26 upgrade (ADR-016 / issue #114) is a non-starter while its schema shares a database with live app data.
- **Least privilege.** The `givernance` owner role had access to Keycloak's tables, and the RLS model in `docs/06-security-compliance.md` §3.2 does not cover Keycloak tables — there was no enforceable boundary.
- **Observability.** `\dt` in the app DB was dominated by Keycloak's tables; distinguishing app objects required prefix filtering, and audits conflated the two systems.

No other co-located service hit this failure mode — Redis, MinIO, and Mailpit each own their own storage. Only Postgres was shared, and only with Keycloak.

### Decision

**One logical database per tool.** We keep a single Postgres *instance* (cluster) but give each tool its own logical database and a dedicated owner role. Specifically:

- `givernance` — application data, owner role `givernance`, app-facing role `givernance_app` (NOBYPASSRLS; see §6 of `docs/02-reference-architecture.md`).
- `givernance_keycloak` — Keycloak's internal schema, owner role `keycloak`, no shared access with any other service.

The `givernance_keycloak` database + role are provisioned on first Postgres bring-up by `infra/postgres/init/01-init-keycloak-db.sh`, driven by the `KEYCLOAK_DB_NAME`, `KEYCLOAK_DB_USER`, `KEYCLOAK_DB_PASSWORD` environment variables passed into the postgres service. Keycloak reads the same three variables to build its JDBC URL.

**General rule (binding on all future infra):** never co-locate an application schema with a third-party service's schema (Keycloak, future IdPs, dashboards, etc.) in the same logical database. Any new tool that needs Postgres storage gets its own logical DB and its own role. This is recorded in `CLAUDE.md`, `docs/infra/README.md`, and the specialized agents (`platform-architect`, `data-architect`, `security-architect`, `mvp-engineer`) so that a future Compose/infra change proposal enforces it by default rather than asking again.

### Rationale

- **Separate blast radius.** A schema-altering Keycloak upgrade (24 → 26) now operates on `givernance_keycloak` only — the app DB is untouchable by the `keycloak` role.
- **Independent backup/restore.** `pg_dump -d givernance` produces an app-only dump; the IdP can be rebuilt from the realm export without restoring (or rolling back) app data.
- **Least privilege by construction.** The `keycloak` role owns exactly one DB; the `givernance` owner has no grants on Keycloak's DB. `public` in each DB belongs to the right tool.
- **Keeps the ADR-001 single-instance posture.** We did not split into two Postgres clusters — that would double operational cost in dev and in SaaS. One instance, two DBs, two roles is the Postgres-native answer.
- **Unblocks ADR-016 / issue #114.** The Keycloak 26 + Organizations migration can now ship without risking live application data on a realm-level schema change.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Keep a single shared database | Zero infra change | All the risks above; kills any Keycloak 26 upgrade path | Rejected — the status quo this ADR replaces |
| Two Postgres *instances* (cluster-per-tool) | Full SLA + config isolation for the IdP | Double ops cost; two volumes, two backups, two health checks; overkill for Phase 1-3 | Rejected for now — re-evaluate if the IdP's SLA requirements diverge sharply from the app's |
| Separate **schemas** inside the same DB (`keycloak.*`) | Namespaces the tables | `pg_dump` still couples them; one role can still touch both; Keycloak's JDBC config is awkward with search_path | Rejected |
| Put Keycloak on SQLite / H2 in local dev | Smallest footprint | Divergence from prod (Scaleway Managed PostgreSQL) invites first-time-on-Postgres surprises | Rejected |

### Consequences

- **Local dev.** A fresh `docker compose up -d` runs `infra/postgres/init/01-init-keycloak-db.sh` once and brings up a pre-provisioned `givernance_keycloak` DB + `keycloak` role. Existing developers must reset volumes once (`docker compose down -v && docker compose up -d`) because the init script only fires on an empty `pgdata` volume; Keycloak dev realm state is regenerated from `infra/keycloak/realm-givernance.json` + `scripts/keycloak-sync-realm.sh`.
- **`scripts/dev-up.sh`** now reads Keycloak's `realm` table from `${KEYCLOAK_DB_NAME}` (not `${POSTGRES_DB}`) when relaxing the `master` realm's `ssl_required`.
- **`.env.example` / `.env`** now carry `KEYCLOAK_DB_NAME`, `KEYCLOAK_DB_USER`, `KEYCLOAK_DB_PASSWORD`, defaulted for local dev. The CI-test passwords are committed as-is in `.env.example`; production overrides them via Scaleway secrets.
- **CI.** `.github/workflows/ci.yml` is unchanged — CI does not spin up Keycloak today, only the app DB (`givernance_test`). When Keycloak-dependent e2e tests land, they must use a separate `givernance_keycloak_test` database and must not reuse `givernance_test`.
- **SaaS production (Scaleway).** Provision `givernance_keycloak` as a second logical database on the same Scaleway Managed PostgreSQL instance for Phase 1–3. Operator steps (Scaleway console, one-off, documented in the launch runbook):
  1. Scaleway console → *Managed Databases* → your cluster → *Users* tab → **Create user** `keycloak` with a long random password; disable the "is admin" toggle. Store the password in the Scaleway secret manager under `givernance/prod/keycloak_db_password`.
  2. Same cluster → *Databases* tab → **Create database** `givernance_keycloak` and set its owner to the `keycloak` user from step 1.
  3. In the Kamal secret inventory, set `KEYCLOAK_DB_NAME=givernance_keycloak`, `KEYCLOAK_DB_USER=keycloak`, and bind `KEYCLOAK_DB_PASSWORD` to the secret-manager entry. The same env contract as local dev — no code change across environments.
  4. Connect as `keycloak` once and run the same `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO keycloak;` that `infra/postgres/init/01-init-keycloak-db.sh` runs in dev. Scaleway does not execute init scripts.

  If Keycloak's SLA or failure-isolation requirements later diverge from the app's, revisit and move Keycloak to a smaller dedicated Scaleway Managed PostgreSQL — the topology decision, not the split itself, is the variable.
- **Self-hosted deployments.** The same Docker Compose file drives both local and self-hosted; the init script and env vars apply unchanged.
- **Documentation guardrail.** `CLAUDE.md`, `docs/infra/README.md`, `docs/02-reference-architecture.md`, `docs/03-data-model.md`, and the specialized agent playbooks all carry the one-DB-per-tool rule, so a new service proposal triggers an explicit decision rather than a silent co-location.

### Revisit criteria

- If Keycloak's availability, RPO, or compliance posture diverges from the app's, split to a dedicated Postgres instance (option 2 above) rather than continuing to share the cluster.
- If a third co-located tool appears (it won't, by this ADR), revisit whether a different primitive — e.g., a managed Keycloak on Scaleway's marketplace, or another IdP entirely — removes the need for a shared cluster.

---

