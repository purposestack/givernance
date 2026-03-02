# 02 — Reference Architecture

> Last updated: 2026-02-24

---

## 1. Architecture decision: Modular monolith first

**Decision**: Start as a single deployable application with clear internal module boundaries. Extract to microservices only when specific modules demonstrate: (a) independent scaling requirements, (b) separate deployment cadence needs, or (c) team ownership boundaries.

**Rationale**: NPO market segment is predominantly SME. Operational complexity of microservices (distributed tracing, service mesh, eventual consistency handling) adds cost without early benefit. A modular monolith delivers 90% of the microservices benefits (separation of concerns, clear interfaces) at 20% of the operational overhead. PostgreSQL handles tens of thousands of concurrent connections with PgBouncer; vertical scaling is cheap.

**Tradeoffs**:
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Microservices from day 1 | Independent scaling, fault isolation | High ops overhead, complex local dev, premature optimization | Reject |
| Modular monolith | Fast dev, simple deployment, easy debugging | Single deployment unit, shared DB | **Selected** |
| Simple monolith (no modules) | Fastest to start | Technical debt accumulates rapidly, hard to maintain | Reject |

**Exit criteria for extracting a service**: Module exceeds 10K req/min sustained, or team size exceeds 8 engineers owning that domain, or module requires different runtime/language.

---

## 2. System context

```
See: /diagrams/context.mmd
```

Actors:
- **NPO Staff** (fundraising manager, program manager, volunteer coordinator, data entry)
- **NPO Administrator** (configures org, manages users, runs GDPR actions)
- **Beneficiaries** (optional self-service portal for case access)
- **Volunteers** (self-service portal for shift booking and hour logging)
- **Finance/Auditors** (read-only access to reports and GL exports)
- **Platform Operator** (Givernance operations team — super_admin)

External systems:
- **Stripe / Mollie** — payment processing (recurring donations, SEPA)
- **Keycloak** — identity and access management
- **Resend / Brevo** — transactional and bulk email
- **S3-compatible storage** — documents, exports, receipts
- **NATS JetStream** — internal event bus
- **Xero / QuickBooks** — accounting integration (write)
- **Salesforce** — migration source (read-only during migration)

---

## 3. Container architecture

```
See: /diagrams/container.mmd
```

### 3.1 Core containers

#### `givernance-api` (Go 1.23)
- Single deployable Go binary
- Domain modules: `constituents`, `donations`, `campaigns`, `grants`, `programs`, `volunteers`, `impact`, `finance`, `comms`, `auth`, `admin`
- Chi router + middleware stack (auth, audit, rate limit, tracing)
- Connects to PostgreSQL via PgBouncer (transaction mode)
- Publishes domain events to NATS JetStream outbox consumer
- Serves REST API on `:8080`; admin API on `:8081` (internal only)
- Health: `GET /healthz`, `GET /readyz`

#### `givernance-web` (Next.js 15 / React 19)
- Server-side rendered for list/detail pages (SEO not required; SSR for performance)
- Client components for interactive forms and dashboards
- Connects to `givernance-api` only (no direct DB)
- Auth: OIDC flow through Keycloak; JWT stored in httpOnly cookie
- Static assets served from CDN (CloudFront / Cloudflare)

#### `givernance-worker` (Go 1.23)
- Async job processor (Asynq queue on Redis)
- Jobs: PDF generation, bulk email send, import processing, scheduled reports, GL export, GDPR erasure execution, recurring donation installment creation
- Shares codebase with `givernance-api` (same Go module); separate binary entry point

#### `givernance-migrate` (Go 1.23 or Python 3.12)
- One-off migration tool for Salesforce data
- Reads from S3 (exported SF data), transforms, loads via direct DB connection
- Not running in production; invoked during migration engagements
- See [05-integration-migration.md](./05-integration-migration.md)

### 3.2 Infrastructure containers

#### `postgresql` (PostgreSQL 16)
- Primary datastore
- Row-level security enabled on all tenant tables
- WAL archiving to S3 (continuous backup)
- Logical replication slot for read replica (reporting workload)
- Extensions: `uuid-ossp`, `pgcrypto`, `pg_trgm`, `ltree`, `pg_audit`

#### `pgbouncer` (PgBouncer 1.22)
- Transaction-mode pooling
- Application connects to PgBouncer on `5432`; PgBouncer connects to PG on `5433`
- Pool size: max 50 connections to PG; max 500 client connections
- `SET LOCAL` for tenant context on every transaction

#### `redis` (Redis 7 / Valkey)
- Job queue backend (Asynq)
- Rate limiting counters
- Session cache (short-lived, separate DB index)
- Feature flags cache

#### `keycloak` (Keycloak 24)
- OIDC provider; issues JWTs consumed by `givernance-api`
- Realms: one per deployment (not per tenant — tenant isolation is in the application layer)
- Flows: standard, SAML 2.0 bridge, magic link for volunteers
- Brute-force protection, MFA enforcement by role

#### `nats` (NATS JetStream 2.10)
- Event bus for domain events (transactional outbox → NATS publisher)
- Streams: `constituent.events`, `donation.events`, `program.events`, `comms.events`
- Retention: `WorkQueuePolicy` (consumed once); dead-letter stream for failures
- Consumer: `givernance-worker` for email triggers, webhook fanout, audit supplementation

#### `minio` (S3-compatible, self-hosted option)
- Stores: PDF receipts, bulk export files, imported constituent lists, document attachments
- Lifecycle policy: exports deleted after 7 days; receipts retained 7 years

---

## 4. Module map (within `givernance-api`)

```
givernance-api/
├── cmd/
│   ├── api/          # HTTP server entry point
│   └── worker/       # Job worker entry point
├── internal/
│   ├── auth/         # JWT validation, Keycloak integration, RBAC middleware
│   ├── constituents/ # Persons, households, organizations, relationships
│   ├── donations/    # Gifts, pledges, installments, funds, allocations
│   ├── campaigns/    # Campaign management, source tracking
│   ├── grants/       # Grant pipeline, funder relations, deliverables
│   ├── programs/     # Program catalog, enrollments, service delivery
│   ├── beneficiaries/# Beneficiary records, case notes, outcomes
│   ├── volunteers/   # Volunteer profiles, shifts, hours
│   ├── impact/       # Indicators, readings, ToC, dashboards
│   ├── finance/      # Fund accounting, GL export, batch closing
│   ├── comms/        # Email templates, bulk sends, receipts
│   ├── reporting/    # Standard reports, custom queries, exports
│   ├── gdpr/         # SAR, erasure, consent management
│   ├── admin/        # Org settings, users, custom fields, billing
│   └── platform/     # Super-admin: org provisioning, feature flags
├── pkg/
│   ├── db/           # DB connection, RLS context setter, transaction helpers
│   ├── events/       # Domain event types, outbox publisher
│   ├── jobs/         # Job types, Asynq client
│   ├── audit/        # Audit middleware, audit log writer
│   ├── pagination/   # Cursor-based pagination
│   └── validator/    # Input validation helpers
└── migrations/       # SQL migration files (golang-migrate compatible)
```

---

## 5. API strategy

### 5.1 REST API (primary)

- **Base URL**: `https://api.givernance.app/v1`
- **Versioning**: URL path (`/v1`, `/v2`) — major breaking changes only
- **Auth**: Bearer token (JWT issued by Keycloak); token introspection cached in Redis
- **Format**: JSON everywhere; `Content-Type: application/json`
- **Pagination**: Cursor-based (`?cursor=<opaque>&limit=50`); never offset-based
- **Errors**: RFC 7807 Problem Details (`type`, `title`, `status`, `detail`, `instance`)
- **Timestamps**: ISO 8601 with timezone (`2024-03-15T14:30:00Z`)
- **IDs**: UUID v7 (string format in JSON)
- **Envelopes**: Collections return `{data: [...], meta: {total, cursor_next, cursor_prev}}`

### 5.2 Webhook API (outbound)

- NPO admins can register webhook endpoints for domain events
- Payload: CloudEvents 1.0 format
- Delivery: at-least-once; retry with exponential backoff (1s, 5s, 30s, 5m, 30m)
- Signature: `X-Givernance-Signature: sha256=<hmac>` (org-specific secret)
- Failure threshold: 50 consecutive failures → webhook disabled; email to org admin

### 5.3 Bulk export API

- Async: `POST /v1/exports` → returns `{export_id}`
- Poll: `GET /v1/exports/{id}` → `{status: "pending|processing|ready|failed", download_url}`
- Download URL: presigned S3 URL, valid 1 hour
- Formats: CSV, JSON, XLSX (XLSX via Go library, not spreadsheet service)

### 5.4 Import API

- `POST /v1/imports` multipart/form-data with file upload
- Async processing in worker; progress via `GET /v1/imports/{id}`
- Validation report: `{valid_count, error_count, errors: [{row, field, message}]}`

---

## 6. Tenancy model

**Model**: Shared database, shared schema, row-level isolation.

```sql
-- RLS enforced via PostgreSQL policies
-- Connection context set per request by API middleware:

BEGIN;
SET LOCAL app.current_org_id   = '018e1234-...'; -- UUID v7
SET LOCAL app.current_user_id  = '018e5678-...';
SET LOCAL app.current_role     = 'fundraising_manager';
-- All queries in this transaction are automatically filtered by org_id
COMMIT;
```

**Why shared schema over separate schemas**:
- Simpler migrations (one migration file applies to all orgs)
- Easier cross-org reporting for platform operations
- Lower DB overhead (no thousands of schema namespaces)
- PgBouncer works correctly in transaction mode

**Security boundary**: RLS policies are the only tenant boundary. All policies tested in integration test suite with cross-tenant access attempts. PgBouncer user does NOT have permission to bypass RLS (no `BYPASSRLS`).

---

## 7. Eventing and workflows

### 7.1 Transactional outbox

```
1. API handler writes mutation to DB (e.g., INSERT INTO donations)
2. In same DB transaction: INSERT INTO domain_events (event_type, payload, published=false)
3. Transaction commits
4. Background poller (every 500ms): SELECT unpublished events → publish to NATS → mark published
5. NATS delivers to subscribers (worker processes)
```

**Why outbox, not direct publish**: Guarantees event delivery even if NATS is temporarily unavailable; no dual-write problem.

### 7.2 Domain events (key examples)

| Event | Trigger | Subscribers |
|---|---|---|
| `donation.created` | New donation saved | Receipt generator, campaign updater, fund balance updater, audit |
| `constituent.gdpr_erased` | Erasure executed | All tables PII scrubber, audit |
| `pledge.installment_due` | Scheduled task (daily) | Payment initiator (Stripe), reminder email |
| `grant.deadline_approaching` | Scheduled (30/14/7 days before) | Notification service |
| `volunteer.shift_assigned` | Shift assignment saved | Confirmation email, calendar invite |
| `beneficiary.enrolled` | Enrollment created | Program capacity updater, welcome email |

### 7.3 Scheduled tasks

Implemented as Asynq periodic tasks (cron expression in config):

| Task | Schedule | Description |
|---|---|---|
| `process_pledge_installments` | Daily 06:00 UTC | Create due installments, initiate SEPA payment |
| `send_grant_reminders` | Daily 08:00 UTC | Check grant deadlines, send reminders |
| `calculate_donor_lifecycle` | Weekly Sunday 02:00 | Recalculate LYBUNT/SYBUNT flags |
| `refresh_materialized_views` | Hourly | Refresh reporting views |
| `cleanup_expired_exports` | Daily 03:00 UTC | Delete S3 exports older than 7 days |
| `gdpr_erasure_execution` | Daily 04:00 UTC | Execute queued erasure requests |

---

## 8. Reporting architecture

### 8.1 Read model

- Separate PostgreSQL read replica for report queries (prevents analytics from impacting OLTP)
- Materialized views for common aggregations: `mv_donor_summary`, `mv_campaign_performance`, `mv_fund_balance`, `mv_volunteer_hours`
- Views refreshed hourly (concurrent refresh — no lock)
- Custom report queries run against read replica

### 8.2 Standard reports

Implemented as parameterized SQL queries exposed via API (`GET /v1/reports/{report_id}?params=...`):

| Report | Description |
|---|---|
| Donor retention (LYBUNT) | Donors who gave last year but not this year |
| SYBUNT | Donors who gave some year but not this year |
| Campaign ROI | Revenue vs cost per campaign |
| Fund balance | Restricted fund balances by period |
| Volunteer hours by program | Total hours and valuation per program per period |
| Beneficiary outcomes | Enrollment counts, completion rates, outcome types |
| Donation source analysis | Revenue by source code / channel |
| Recurring revenue projection | Future pledge installments by month |
| Lapsed donor segment | Donors with last gift > 18 months ago |
| Impact KPI dashboard | All indicators vs targets for current period |

### 8.3 Export formats

- **CSV**: All list views; simple tabular export
- **XLSX**: Formatted reports with headers and totals
- **PDF**: Receipts, impact summaries, funder reports (generated via `chromedp` or `wkhtmltopdf`)
- **JSON**: API-native; used for accounting integration payloads

---

## 9. Deployment configurations

### 9.1 Single-server (SME NPO self-hosted)

```yaml
# docker-compose.yml skeleton
services:
  api:         givernance/api:latest
  web:         givernance/web:latest
  worker:      givernance/worker:latest
  postgres:    postgres:16-alpine
  pgbouncer:   pgbouncer/pgbouncer:latest
  redis:       redis:7-alpine
  keycloak:    keycloak/keycloak:24
  nats:        nats:2.10-alpine
  minio:       minio/minio:latest
  caddy:       caddy:2-alpine      # TLS termination + reverse proxy
```

Minimum server: 4 vCPU, 8 GB RAM, 100 GB SSD — handles 5–50 concurrent users.

### 9.2 Managed SaaS (Givernance hosting)

```
CDN (Cloudflare) → Load Balancer → givernance-web (2 replicas)
                                 → givernance-api (3 replicas)
                                 → PgBouncer → PostgreSQL primary + 1 read replica
                                 → Redis Cluster
                                 → Keycloak (2 replicas)
                                 → NATS Cluster (3 nodes)
                                 → MinIO (or AWS S3)
```

### 9.3 Template deployment (Kamal)

```bash
# Deploy a new org instance (single-server SaaS model)
kamal deploy --destination eu-west-1-prod
kamal app exec --reuse -- ./givernance migrate up
kamal app exec --reuse -- ./givernance seed --org-template=standard-npo
```

---

## 10. Non-functional requirements

| NFR | Requirement | Measurement |
|---|---|---|
| API p99 latency | < 300 ms for list (50 items), < 100 ms for single record | Prometheus histogram |
| API throughput | 500 req/s sustained per deployment | Load test with k6 |
| Concurrent users | 200 concurrent users per deployment | Load test with k6 |
| Uptime | 99.5% monthly (self-hosted), 99.9% (managed SaaS) | UptimeRobot |
| RTO | 4 hours | DR test quarterly |
| RPO | 1 hour (WAL archiving) | Backup verification monthly |
| DB backup retention | 30 days | S3 lifecycle policy |
| Max constituent records | 500,000 per org (hard limit at shared tier) | DB partition pruning |
| Receipt generation time | < 5 seconds from donation save | Job queue SLA |
| Bulk email throughput | 10,000 emails/hour | Resend/Brevo rate limit |
| GDPR erasure SLA | 30 days from verified request | Automated tracking |
| Audit log retention | 7 years | S3 Glacier after 1 year |
| TLS version | TLS 1.3 minimum | SSL Labs A rating |
