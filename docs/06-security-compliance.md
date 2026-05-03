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

### Impersonation (issue #24, two-mode design)

Two coexisting support-session modes are documented in [`docs/19-impersonation.md`](./19-impersonation.md):

- **Delegation** — operator retains super_admin powers on a tenant's configuration. RFC 8693 `act` claim. Default 2h, capped 4h.
- **Pure impersonation** — operator assumes the user's identity to reproduce a bug. Writes blocked at the middleware. Default 30m, capped 1h.

**GDPR specifics:**

- `impersonation_sessions` rows are **audit records exempt from Art. 17 erasure** (same principle as `audit_logs`). The append-only DB trigger (`prevent_impersonation_session_mutation`, migration 0033) enforces this at the Postgres level — only `(ended_at, end_reason)` may transition NULL→non-NULL once.
- A subject's DSAR export under Art. 15 includes `impersonation_sessions` rows where they are EITHER the impersonated user OR the operator — both identities are visible in the export.
- Reason field is mandatory (≥ 20 chars, DB CHECK constraint) — creates an auditable paper trail of WHY a platform admin accessed an account.
- Step-up MFA is delegated to Keycloak via OIDC `auth_time` + `acr` (production hard-fails to `IMPERSONATION_REQUIRE_ACR_2=true`); no app-side TOTP store.

### Operator MFA enrolment & recovery (issue #250)

MFA is **only** required for impersonation and delegation — every other flow (normal login, dashboard, donations, settings, etc.) works unchanged for every user, including super-admins. Enrolment is lazy: nobody is force-enrolled at normal login.

- Normal login: the realm's `browser-with-step-up` flow is the default browserFlow, but its Conditional-LoA sub-flow only fires when the OIDC client requests `acr_values=2`. Without that param, the conditional evaluates skip and the OTP step is bypassed entirely — same UX as before this PR.
- First impersonation attempt for a super-admin who hasn't enrolled: the API 401s `acr_insufficient`, the web bounces them to Keycloak with `acr_values=2`, and the OTP form's `userSetupAllowed: true` flag transparently routes them through KC's built-in TOTP enrolment screen (FreeOTP / Google Authenticator / Microsoft Authenticator) under the Givernance theme. After enrolment + verification, the flow continues, an `acr=2` token is issued, and they're returned to the impersonation form. Full sequence + realm JSON details in [`docs/19-impersonation.md`](./19-impersonation.md) §7.
- Subsequent impersonation attempts: within the 5-minute `loa-max-age` window, the user is already at LoA 2 and the OTP prompt is skipped. Past that window, they're prompted only for the OTP code.
- **Recovery (lost device)**: any operator with realm-management `manage-users` access opens the user in the Keycloak admin console (e.g. `https://auth.staging.givernance.org/admin/master/console/`), Credentials tab → delete the OTP credential. Next impersonation attempt routes them through fresh enrolment automatically (no extra step needed because of `userSetupAllowed: true`).
- **Why no self-serve "I lost my phone" flow**: the same TOTP gates the impersonation route into every tenant's data, so account-takeover via SMS recovery / email reset would defeat the purpose of step-up. Manual recovery via Keycloak admin is the deliberate fail-safe.

#### Residual risk: lazy enrolment + stolen password (accepted, pre-prod)

`auth-otp-form.userSetupAllowed = true` lets a super-admin who has never enrolled walk through the QR screen on their first `acr_values=2` request. If their password is phished/leaked before they've enrolled, the attacker can scan the QR with their own authenticator, satisfy the step-up gate, and start an impersonation session.

**Why we accepted this in pre-prod:** during initial bootstrap, a small operator team shares the seeded super-admin account and has no out-of-band channel to coordinate a one-time MFA enrolment across all members. Lazy enrolment is the only practical UX while in this state.

**Hardening before production:** issue #258 tracks the Phase 4 work to flip to proactive `CONFIGURE_TOTP` (or an out-of-band enrolment link) before the first production deploy. Triggers for revisiting:
- `deploy-production.yml` lands
- Real beneficiary data lives behind impersonation
- Per-operator super-admin accounts replace the shared seed (via the platform-admin invite flow, PR #253)

## Security operations
- SAST/DAST in CI
- Dependency scanning + SBOM
- Quarterly access review
- Incident runbooks (P1/P2)
- Backup policy: daily full + PITR, restore drills monthly
