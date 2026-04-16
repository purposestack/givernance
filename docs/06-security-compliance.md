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
