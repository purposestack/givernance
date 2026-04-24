# 06 — Security & Compliance (EU/GDPR)

> Last updated: 2026-04-14

## Control baseline
- Data residency: EU-only regions by default
- Encryption at rest (AES-256) + in transit (TLS 1.3 minimum)
- Tenant isolation via PostgreSQL RLS with **3-role pattern** (see below)
- RBAC + permission scopes by capability
- Immutable audit log for privileged actions
- Secrets in vault; no plaintext secrets in DB
- All API error responses use **RFC 9457** (`application/problem+json`) with strict `schema.response` on all routes to prevent PII leakage
- Structured logging via **Pino** with built-in PII redaction (defense in depth)

## Database role model (3-role pattern)

| Role | Attributes | Connection | Used by |
|------|-----------|------------|---------|
| `givernance` | Owner, `BYPASSRLS` | `DATABASE_URL` | Migrations, relay, workers |
| `givernance_app` | `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEDB` | `DATABASE_URL_APP` | API server |
| `postgres` | Superuser | — | Infrastructure only |

The API server **always** connects via the `givernance_app` role, which is subject to all RLS policies. All tenant-scoped tables have `FORCE ROW LEVEL SECURITY` enabled, so even the table owner cannot bypass policies accidentally.

The API wraps all tenant queries in `withTenantContext(orgId, callback)`, which sets `app.current_org_id` via transaction-scoped `set_config`. This ensures tenant context never leaks across pooled connections.

> A global Fastify `preHandler` with session-level `set_config` was explicitly rejected — it is unsafe with connection pooling (PgBouncer transaction mode). See [03-data-model.md §4](./03-data-model.md) for full details.

## PII redaction (defense in depth)

Three layers prevent PII from appearing in logs or error responses:

1. **Pino `redact` option**: All service loggers (API, relay, worker) strip known PII paths: `authorization`, `cookie`, `password`, `token`, `iban`, `cardNumber`, `cvv`, `pan`
2. **Custom serializers**: Domain objects are logged with safe projections only (`{ id, type }`, never `{ email, name }`)
3. **RFC 9457 strict response schemas**: All routes define explicit `schema.response` — only declared fields are serialized. Undeclared PII fields on internal objects are never exposed to clients.

## GDPR-by-design
- Lawful basis per contact/communication
- Consent ledger (channel + purpose + timestamp)
- DSAR tooling: export, rectify, erase
- Pseudonymization for deleted PII while preserving finance integrity
- Data retention policies per object class

### DSAR / SAR spans two logical databases (ADR-017)

Since [ADR-017](./15-infra-adr.md#adr-017-one-logical-database-per-tool--isolate-keycloak-from-the-application-db), a full Subject Access Request export must cover **both** the application DB and the Keycloak DB:

| Database | PII held | Joined by |
|---|---|---|
| `givernance` | Constituent records, donations, case notes, comms, consent ledger, app-level audit logs | `constituents.id`, `users.id` (Keycloak `sub` claim stored as `users.keycloak_user_id`) |
| `givernance_keycloak` | Email, username, phone, profile attributes, login events, session history for staff users | `user_entity.id` = the `sub` claim in issued tokens |

Operational impact:

- **Export:** the DSAR tool must query both DBs and join on the `sub`/`keycloak_user_id` link; a single `pg_dump -d givernance` no longer produces a complete subject export for staff users.
- **Erasure:** the right-to-erasure flow must delete app-DB PII **and** instruct Keycloak to delete the user (via the Admin API `DELETE /users/{id}` — do not issue raw DELETEs against `user_entity` from the app role, which has no grants on `givernance_keycloak` anyway).
- **Beneficiaries / external constituents** live only in `givernance` (they are not Keycloak users); their SAR flow is unchanged.
- **Retention:** Keycloak event-log retention (`events-expiration`, `admin-events-expiration`) is configured inside the realm and must match the app-side retention policy — otherwise one DB ages out PII before the other.

## Access model
- Roles: super_admin, org_admin, fundraising_manager, program_manager, volunteer_coordinator, data_entry, finance_viewer, volunteer, beneficiary, report_only
- Privileged operations require step-up auth + reason field
- Break-glass access logged and time-limited

## Security operations
- SAST/DAST in CI
- Dependency scanning + SBOM
- Quarterly access review
- Incident runbooks (P1/P2)
- Backup policy: daily full + PITR, restore drills monthly
