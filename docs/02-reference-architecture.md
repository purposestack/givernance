# 02 — Reference Architecture

> Last updated: 2026-03-09

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
- **Scaleway Object Storage / S3-compatible storage** — documents, exports, receipts
- **Xero / QuickBooks** — accounting integration (write)
- **Salesforce** — migration source (read-only during migration)
- **NATS JetStream** — internal event bus *(Phase 4+ only — see ADR-001)*

---

## 3. Container architecture

```
See: /diagrams/container.mmd
```

### 3.1 Core containers

#### `givernance-api` (TypeScript, Fastify 5)
- TypeScript ESM application running on Node.js 22 LTS
- Domain modules: `auth`, `constituents`, `donations`, `campaigns`, `grants`, `programs`, `beneficiaries`, `volunteers`, `impact`, `finance`, `comms`, `reporting`, `gdpr`, `admin`, `platform`
- Fastify 5 router + plugin stack (auth, audit, rate limit, tracing); TypeBox for OpenAPI schema validation + type-safe routes
- Drizzle ORM for type-safe PostgreSQL queries; connects via PgBouncer (transaction mode, or directly to managed Neon.tech in SaaS deployment)
- Zod for runtime input validation with inferred TypeScript types
- Publishes domain events via transactional outbox → BullMQ job queue (NATS JetStream deferred to Phase 4+)
- Serves REST API on `:8080`; admin API on `:8081` (internal only)
- Health: `GET /healthz`, `GET /readyz`

#### `givernance-web` (Next.js 15 / React 19)
- Server-side rendered for list/detail pages (SEO not required; SSR for performance)
- Client components for interactive forms and dashboards
- Connects to `givernance-api` only (no direct DB)
- Auth: OIDC flow through Keycloak; JWT stored in httpOnly cookie
- Static assets served from CDN (CloudFront / Cloudflare)

#### `givernance-worker` (TypeScript, BullMQ 5)
- Async job processor (BullMQ queues on Redis)
- Jobs: PDF generation, bulk email send, import processing, scheduled reports, GL export, GDPR erasure execution, recurring donation installment creation
- Shares types and schemas with `givernance-api` via `@givernance/shared` package; separate process entry point

#### `givernance-migrate` (TypeScript, Drizzle Kit)
- One-off migration tool for Salesforce data
- Reads from S3 (exported SF data), transforms, bulk-loads via Drizzle ORM
- DB schema migrations managed by Drizzle Kit (generate, push, migrate)
- Not running in production; invoked during migration engagements
- See [05-integration-migration.md](./05-integration-migration.md)

### 3.2 Infrastructure containers

#### `postgresql` (PostgreSQL 16)
- Primary datastore
- Row-level security enabled on all tenant tables
- WAL archiving to S3 (continuous backup)
- Logical replication slot for read replica (reporting workload)
- Extensions: `uuid-ossp`, `pgcrypto`, `pg_trgm`, `ltree`, `pg_audit`
- **Self-hosted deployments**: PostgreSQL 16 + PgBouncer (Docker Compose)
- **SaaS managed deployment**: [Scaleway Managed PostgreSQL](https://www.scaleway.com/en/database/) EU region — includes connection pooling, read replicas, WAL backup, full extension support. See [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider).

#### `pgbouncer` (PgBouncer 1.22)
- Transaction-mode pooling — **self-hosted deployments only**
- Application connects to PgBouncer on `5432`; PgBouncer connects to PG on `5433`
- Pool size: max 50 connections to PG; max 500 client connections
- `SET LOCAL` for tenant context on every transaction
- *SaaS deployment*: Neon.tech includes built-in connection pooling (pgBouncer-compatible) — no separate container needed.

#### `redis` (Redis 7 / Valkey)
- Job queue backend (BullMQ) — **primary event routing mechanism for Phase 0-3**
- Rate limiting counters
- Session cache (short-lived, separate DB index)
- Feature flags cache
- **Self-hosted deployments**: Redis 7 / Valkey (Docker Compose)
- **SaaS managed deployment**: [Scaleway Managed Redis](https://www.scaleway.com/en/managed-databases-for-redis/) EU region — managed, GDPR-compliant, single vendor DPA. See [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider).

#### `keycloak` (Keycloak 24)
- OIDC provider; issues JWTs consumed by `givernance-api`
- Realms: one per deployment (not per tenant — tenant isolation is in the application layer)
- Flows: standard, SAML 2.0 bridge, magic link for volunteers
- Brute-force protection, MFA enforcement by role
- Retained in all deployment modes — no managed alternative covers the full feature set (SAML 2.0, magic-link, MFA by role). See [ADR-007](./15-infra-adr.md#adr-007-reject-convexdev-and-supabase-as-all-in-one-backend-replacements).

#### `storage` (Cloudflare R2 / MinIO)
- Stores: PDF receipts, bulk export files, imported constituent lists, document attachments
- Lifecycle policy: exports deleted after 7 days; receipts retained 7 years
- **Self-hosted deployments**: [MinIO](https://min.io) (S3-compatible, Docker Compose)
- **SaaS managed deployment**: [Scaleway Object Storage](https://www.scaleway.com/en/object-storage/) — S3-compatible API, EU storage, native GDPR coverage. See [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider).

#### `nats` ⚠️ Phase 4+ only
> **NATS JetStream is deferred to Phase 4.** It is not part of the Phase 0-3 infrastructure.
>
> In Phase 0-3, domain events are routed via the **transactional outbox → BullMQ (Redis)** pipeline, which provides at-least-once delivery, retries, and dead-letter queues natively.
>
> NATS JetStream will be introduced in Phase 4 when:
> - A second autonomous service is extracted from the monolith and needs to consume domain events
> - Outbound webhook fan-out requires multi-subscriber delivery at scale
> - Event replay capability is needed for audit enrichment or debugging
>
> The outbox pattern intentionally abstracts the publish backend — switching from BullMQ-direct to NATS requires changing one module (`packages/shared/src/events/publisher.ts`), with zero domain logic changes.
>
> See [ADR-005](./15-infra-adr.md#adr-005-nats-jetstream--deferred-to-phase-4) for full decision record.

---

## 4. Module map (pnpm monorepo)

```
packages/
├── shared/                  # @givernance/shared — shared types, schemas, utils
│   ├── src/
│   │   ├── schema/          # Drizzle ORM schema definitions (all tables)
│   │   ├── types/           # Shared TypeScript types
│   │   ├── events/          # Domain event types (CloudEvents)
│   │   ├── jobs/            # BullMQ job type definitions
│   │   └── validators/      # Zod schemas for API input validation
│   └── package.json
├── api/                     # @givernance/api — Fastify API server
│   ├── src/
│   │   ├── server.ts        # Fastify app factory
│   │   ├── plugins/         # Auth, audit, rate-limit, CORS, OpenAPI
│   │   ├── modules/         # Domain modules
│   │   │   ├── auth/        # JWT validation, Keycloak integration, RBAC middleware
│   │   │   ├── constituents/# Persons, households, organizations, relationships
│   │   │   ├── donations/   # Gifts, pledges, installments, funds, allocations
│   │   │   ├── campaigns/   # Campaign management, source tracking
│   │   │   ├── grants/      # Grant pipeline, funder relations, deliverables
│   │   │   ├── programs/    # Program catalog, enrollments, service delivery
│   │   │   ├── beneficiaries/ # Beneficiary records, case notes, outcomes
│   │   │   ├── volunteers/  # Volunteer profiles, shifts, hours
│   │   │   ├── impact/      # Indicators, readings, ToC, dashboards
│   │   │   ├── finance/     # Fund accounting, GL export, batch closing
│   │   │   ├── comms/       # Email templates, bulk sends, receipts
│   │   │   ├── reporting/   # Standard reports, custom queries, exports
│   │   │   ├── gdpr/        # SAR, erasure, consent management
│   │   │   ├── admin/       # Org settings, users, custom fields, billing
│   │   │   └── platform/    # Super-admin: org provisioning, feature flags
│   │   └── lib/             # DB client (Drizzle), Redis client, NATS client, RLS helper
│   └── package.json
├── worker/                  # @givernance/worker — BullMQ job processor
│   ├── src/
│   │   ├── worker.ts        # BullMQ worker entry point
│   │   ├── queues/          # Queue definitions
│   │   └── processors/      # Job processor handlers (one per job type)
│   └── package.json
└── migrate/                 # @givernance/migrate — one-off Salesforce ETL tool
    ├── src/
    │   ├── index.ts         # CLI entry point
    │   ├── extractors/      # Read from SF export (S3/CSV)
    │   ├── transformers/    # Map SF schema to Givernance schema
    │   └── loaders/         # Bulk insert via Drizzle
    └── package.json
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
- Formats: CSV, JSON, XLSX (XLSX via ExcelJS, not spreadsheet service)

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
4. Background poller (every 500ms): SELECT unpublished events → enqueue BullMQ job → mark published
5. BullMQ (Redis) delivers job to givernance-worker (at-least-once, with retries + dead-letter)
```

**Why outbox, not direct publish**: Guarantees job delivery even if Redis is temporarily unavailable; no dual-write problem. BullMQ provides at-least-once delivery, configurable retries, dead-letter queues, and job inspection — all natively.

**Phase 4 migration path**: When NATS is introduced (see §7.4), the outbox poller will publish to NATS instead of enqueueing BullMQ directly. The domain event types and outbox table are unchanged — only `packages/shared/src/events/publisher.ts` is swapped.

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

Implemented as BullMQ repeat jobs (cron expression in config):

| Task | Schedule | Description |
|---|---|---|
| `process_pledge_installments` | Daily 06:00 UTC | Create due installments, initiate SEPA payment |
| `send_grant_reminders` | Daily 08:00 UTC | Check grant deadlines, send reminders |
| `calculate_donor_lifecycle` | Weekly Sunday 02:00 | Recalculate LYBUNT/SYBUNT flags |
| `refresh_materialized_views` | Hourly | Refresh reporting views |
| `cleanup_expired_exports` | Daily 03:00 UTC | Delete S3 exports older than 7 days |
| `gdpr_erasure_execution` | Daily 04:00 UTC | Execute queued erasure requests |

### 7.4 NATS JetStream (Phase 4+)

NATS JetStream will be introduced in Phase 4 when the following conditions are met:

- A second autonomous service is extracted from the monolith and needs to consume domain events independently
- Outbound webhook fan-out requires multi-subscriber delivery at scale (>1,000 webhooks across orgs)
- Event replay capability is needed for debugging or audit enrichment

**Planned stream topology (Phase 4)**:

| Stream | Events | Consumers |
|---|---|---|
| `constituent.events` | created, updated, gdpr_erased | worker, webhook-fanout |
| `donation.events` | created, receipt_generated, fund_allocated | worker, finance-service, webhook-fanout |
| `program.events` | enrolled, completed, outcome_recorded | worker, impact-service |
| `comms.events` | email_sent, bulk_started, suppression_added | worker, audit |

Retention: `WorkQueuePolicy` per consumer group; dead-letter stream for failures after 5 retries.

**Migration from BullMQ-direct**: When NATS is introduced, the outbox poller's publish call is redirected from BullMQ enqueue to NATS publish. BullMQ remains for scheduled/periodic tasks. Zero domain logic changes required.

> See [ADR-005](./15-infra-adr.md#adr-005-nats-jetstream--deferred-to-phase-4) for the full decision record and revisit criteria.

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
- **PDF**: Receipts, impact summaries, funder reports (generated via Puppeteer or `wkhtmltopdf`)
- **JSON**: API-native; used for accounting integration payloads

---

## 9. Deployment configurations

### 9.1 Single-server (SME NPO self-hosted)

All services run locally via Docker Compose. No managed cloud dependencies.

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
  minio:       minio/minio:latest
  caddy:       caddy:2-alpine      # TLS termination + reverse proxy
```

Minimum server: 4 vCPU, 8 GB RAM, 100 GB SSD — handles 5–50 concurrent users.

> **Note**: NATS is not included. Domain events are routed via the transactional outbox → BullMQ (Redis). NATS will be added in Phase 4 when multi-service fan-out is required.

### 9.2 Managed SaaS (Givernance hosting — Phase 0-3)

Managed services replace self-hosted infra for zero-ops database, cache and storage.

```
CDN (Cloudflare) → Load Balancer → givernance-web (2 replicas)
                                 → givernance-api (3 replicas)
                                 → Scaleway Managed PostgreSQL EU (managed, pooling + read replica)
                                 → Scaleway Managed Redis EU (managed)
                                 → Keycloak (2 replicas, self-hosted on Scaleway VMs)
                                 → Scaleway Object Storage EU (documents, receipts, exports)
                                 → Scaleway Cockpit (Grafana + Loki + Mimir + Tempo — observability)
                                 → Scaleway Generative APIs (Mistral / Llama 3.1 — AI inference EU)
```

Deployment: Kamal on Scaleway EU VMs. TLS via Caddy. All services under single Scaleway GDPR DPA.

> See [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider) for full rationale and cost estimates by phase.

> **Phase 4 addition**: NATS JetStream cluster (3 nodes) added for domain event fan-out and webhook scaling.

### 9.3 Infrastructure comparison

| Component | Self-hosted NPO | Managed SaaS (Phase 0-3) | Managed SaaS (Phase 4+) |
|---|---|---|---|
| PostgreSQL | Self-hosted 16 + PgBouncer | Scaleway Managed PostgreSQL EU | Scaleway Managed PostgreSQL EU |
| Redis / Cache | Self-hosted Redis 7 | Scaleway Managed Redis EU | Scaleway Managed Redis EU |
| Object Storage | MinIO | Scaleway Object Storage EU | Scaleway Object Storage EU |
| Event bus | BullMQ via outbox (Redis) | BullMQ via outbox (Redis) | NATS JetStream + BullMQ |
| Auth | Self-hosted Keycloak 24 | Self-hosted Keycloak 24 (Scaleway VM) | Self-hosted Keycloak 24 (Scaleway VM) |
| Observability | Self-managed (Prometheus + Grafana) | Scaleway Cockpit (Grafana + Loki + Mimir + Tempo) | Scaleway Cockpit |
| AI Inference (EU) | Ollama self-hosted | Scaleway Generative APIs (Mistral, Llama 3.1) | Scaleway Managed Inference or Generative APIs |
| Deployment | Docker Compose + Caddy | Kamal + Scaleway EU VMs | Kamal + Scaleway EU VMs |
| Services to operate | 8 | 4 (API, Worker, Web, Keycloak) | 5 (+NATS) |
| GDPR DPA | Self-managed | Single Scaleway DPA | Single Scaleway DPA |

> See [ADR-005](./15-infra-adr.md#adr-005-nats-jetstream--deferred-to-phase-4) and [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider) for full rationale.

### 9.4 Template deployment (Kamal)

```bash
# Deploy a new org instance (managed SaaS model — Hetzner EU VPS)
kamal deploy --destination eu-west-1-prod
kamal app exec --reuse -- pnpm --filter @givernance/migrate drizzle-kit migrate
kamal app exec --reuse -- pnpm --filter @givernance/migrate seed --org-template=standard-npo
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

---

## 11. AI Layer Architecture

> Detail: [13-ai-modes.md](./13-ai-modes.md) · [vision/conversational-mode.md](./vision/conversational-mode.md)

### 11.1 Three interaction modes

Givernance supports three configurable AI modes per organization. The mode is set globally and can be overridden per module or per role.

| Mode | Behavior | Default |
|---|---|---|
| **Mode 1 — Manual** | AI fully disabled; platform works as a traditional CRM | — |
| **Mode 2 — AI-Assisted** | AI observes and suggests; human validates every action | **Default** |
| **Mode 3 — Autopilot** | AI executes routine tasks autonomously; human handles exceptions | Requires 30-day Mode 2 history + ≥75% suggestion acceptance rate |

### 11.2 AI service routing

AI processing is handled inside `givernance-api` by an internal `ai` module (not a separate service). It routes requests to different model backends depending on data sensitivity:

```
packages/api/src/modules/ai/
├── router.ts          # Selects model backend based on data type
├── confidence.ts      # Confidence scoring engine
├── feedback.ts        # Feedback loop (accept/modify/reject signals)
├── suggestions.ts     # Mode 2 suggestion generation
├── actions.ts         # Mode 3 autonomous action execution
└── guard.ts           # ai_execution_guard plugin (403 on restricted actions)
```

### 11.3 Model backends

| Task type | Model | Hosting | Rationale |
|---|---|---|---|
| Text suggestions (emails, thank-you letters) | Claude Haiku 3.5 | Anthropic API (EU DPA) | Fast, economical, good writing |
| Donor trend analysis, scoring, impact narratives | Claude Sonnet 4.5 | Anthropic API (EU DPA) | Stronger reasoning required |
| Grant classification (long documents) | GPT-4o | Azure OpenAI EU region | Good long-text performance |
| Beneficiary data (case notes, medical status) | Mistral 7B / Llama 3.1 8B | Scaleway Generative APIs EU | **No beneficiary PII leaves EU infrastructure — GDPR Art. 9 compliant** |
| Duplicate detection (fuzzy name/email) | pg_trgm + local model | PostgreSQL + local | Lightweight, no LLM needed |

### 11.4 Data policy (non-negotiable)

- **Beneficiary PII** (names, case notes, medical/legal status): processed exclusively by the self-hosted EU model. Never sent to any cloud AI service.
- **Donor PII** (names, emails, amounts): anonymized before cloud dispatch (e.g., "Donateur_A7F2"). The ID↔name mapping stays in the EU database.
- **Non-PII** (aggregate stats, email templates, generic text): may be processed by cloud AI services with signed EU DPA.

### 11.5 Persistence

| Table | Purpose |
|---|---|
| `ai_suggestions` | Mode 2: every suggestion shown to a user (type, model, confidence score, prompt hash, outcome: accepted/modified/rejected) |
| `ai_actions` | Mode 3: every autonomous action executed (trigger, model, outcome, escalated flag, reversal window) |

Both tables are partitioned by `org_id` (tenant isolation) and retained per the audit log retention policy (7 years).

### 11.6 Guard rails

Actions marked `ai_executable: false` at the API layer are blocked by the `ai_execution_guard` middleware, returning `403 AI_RESTRICTED_ACTION`. This is not configurable by org admins. Restricted actions include: financial operations, data deletion, GDPR erasure, consent modification, role/permission changes, bulk sends >1,000 recipients, beneficiary case closure, and minor data processing.

### 11.7 Confidence scoring

Each suggestion carries a confidence score: `f(model_certainty, training_data_density, field_completeness, user_feedback_history)`. Scores below 0.45 are silently suppressed. The feedback loop (accept/modify/reject signals) is processed in a daily batch job per org to update scoring weights. Organization feedback is isolated — one org's corrections do not affect another's.
