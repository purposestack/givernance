# 17 — Log Management Strategy

> **Status**: Partially implemented (Phase 1 Sprint 1-2) — Pino + redaction live in API, Worker, and Relay
> **Owner**: Log Analyst agent (`.claude/agents/log-analyst.md`)
> **Related**: `02-reference-architecture.md`, `06-security-compliance.md`, `15-infra-adr.md`

## 1. Goals

The log management strategy must support investigation of:

- **Bug diagnosis** — trace a failing request from API entry → service logic → DB query → response
- **Performance issues** — identify slow queries, slow endpoints, queue backlogs
- **Data inconsistencies** — correlate mutations across API + Worker with audit trail
- **Flaky tests** — capture test-scoped logs with request context for reproducibility
- **Security incidents** — authentication failures, authorization violations, suspicious access patterns

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     Grafana (dashboards)                      │
└──────┬───────────────────┬──────────────────┬────────────────┘
       │                   │                  │
┌──────▼──────┐     ┌──────▼──────┐    ┌──────▼──────┐
│ Grafana Loki│     │ Prometheus  │    │Grafana Tempo│
│   (logs)    │     │  (metrics)  │    │  (traces)   │
└──────▲──────┘     └──────▲──────┘    └──────▲──────┘
       │                   │                  │
┌──────┴───────────────────┴──────────────────┴────────────────┐
│              OTel Collector (optional gateway)                │
└──────▲───────────────────▲──────────────────▲────────────────┘
       │                   │                  │
┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌─────────────┐
│ Fastify API │  │Outbox Relay │  │BullMQ Worker│  │ Next.js SSR │
│ pino + OTel │  │ pino + OTel │  │ pino + OTel │  │ pino + OTel │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────┘
       │                   │
       ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│    PostgreSQL 16 (instrumentation-pg + audit_log table)       │
└──────────────────────────────────────────────────────────────┘
```

## 3. Technology Choices

### 3.1 Logger: Pino (native to Fastify)

Pino is the **only** logger for Givernance. It is Fastify's built-in logger — using anything else (winston, bunyan) would mean fighting the framework.

| Package | Purpose | Dev/Prod |
|---------|---------|----------|
| `pino` | Core structured JSON logger | Both |
| `pino-pretty` | Human-readable colored output | Dev only |
| `pino-opentelemetry-transport` | Bridge logs → OTel Collector | Prod |
| `pino-loki` | Direct ship to self-hosted Grafana Loki (self-hosted NPO only) | Prod (self-hosted only) |

**Why not winston?** Pino is 5-10x faster (async worker-thread architecture vs. synchronous transforms). Fastify's `fastify.log` and `req.log` are already Pino instances.

### 3.2 Distributed Tracing: OpenTelemetry

| Package | Purpose |
|---------|---------|
| `@opentelemetry/api` | Trace/span API |
| `@opentelemetry/sdk-node` | Auto-configuration SDK |
| `@opentelemetry/exporter-trace-otlp-http` | Export traces to Tempo/Jaeger |
| `@opentelemetry/instrumentation-fastify` | Auto-instrument Fastify routes |
| `@opentelemetry/instrumentation-pg` | Auto-instrument PostgreSQL queries |
| `@opentelemetry/instrumentation-ioredis` | Auto-instrument Redis (BullMQ) |
| `@opentelemetry/instrumentation-undici` | Auto-instrument outbound HTTP (fetch) — Stripe, Keycloak, email providers, AI APIs |

**Do NOT use** `@opentelemetry/auto-instrumentations-node` — it pulls in 40+ instrumentations. Install only the specific ones we need (fastify, pg, ioredis, undici = 4 instrumentations + api + sdk-node + exporter = 7 packages total).

### 3.3 Log Aggregation: Grafana Loki

Lighter than ELK (no JVM), pairs with Prometheus/Mimir (metrics) and Tempo (traces) for a unified Grafana observability stack.

**SaaS deployment**: Scaleway Cockpit provides Grafana + Loki + Mimir + Tempo as a fully managed service under the Scaleway DPA. No self-hosted Loki stack needed — Cockpit ingests OTel-format logs and traces natively.

**Self-hosted deployment**: Docker log driver → Promtail/Alloy → self-hosted Loki. Identical LogQL queries and dashboards.

**Collection method (SaaS)**: OTel Collector → Scaleway Cockpit (native OTLP endpoint). No `pino-loki` transport needed for SaaS — Cockpit ingests OTLP directly.

**Collection method (self-hosted)**: Docker log driver → Promtail/Alloy → self-hosted Loki. Or direct `pino-loki` transport.

### 3.4 Error Tracking: Sentry (optional)

Sentry complements Pino — Pino handles structured logging, Sentry handles error grouping, alerting, and release tracking. GDPR: strip PII from Sentry events via `beforeSend` hook.

## 4. Structured Log Format

Every log line across all services follows this JSON schema:

```json
{
  "level": "info",
  "time": "2026-04-01T10:23:45.123Z",
  "service": "givernance-api",
  "correlationId": "019508d3-7b2a-7f00-8000-1a2b3c4d5e6f",
  "tenantId": "t_greenpeace_fr",
  "userId": "u_abc123",
  "msg": "donation recorded",
  "traceId": "abc123def456...",
  "spanId": "789ghi012..."
}
```

### Mandatory fields

| Field | Source | Required |
|-------|--------|----------|
| `level` | Pino (string label, not numeric) | Always |
| `time` | Pino `isoTime` formatter | Always |
| `service` | Logger `name` option | Always |
| `correlationId` | `X-Request-Id` header or UUIDv7 | Always (API + Worker) |
| `tenantId` | Auth middleware / job metadata | Always (after auth) |
| `userId` | Auth middleware / job metadata | After authentication (null for system/webhook/health requests) |
| `msg` | Explicit log message | Always |
| `traceId` / `spanId` | OTel SDK (auto-injected) | When OTel is active |

## 5. Correlation ID Flow

The `correlationId` traces a single user action across all system boundaries:

```
User action (browser)
  │
  ▼
Fastify API (onRequest hook)
  ├─ Read X-Request-Id header or generate UUIDv7
  ├─ req.correlationId = correlationId
  ├─ req.log = logger.child({ correlationId, tenantId, userId })
  ├─ Reply header: X-Request-Id: correlationId
  │
  ├─► Service layer (receives req.log as dependency)
  │     ├─ Business logic logs use req.log → auto-includes correlation
  │     ├─ Drizzle queries traced via OTel instrumentation-pg
  │     └─ Enqueue BullMQ job:
  │         job.data._meta = { correlationId, tenantId, userId }
  │
  ├─► Transactional outbox (outbox_events table):
  │     outbox_events.payload must include _meta.correlationId from
  │     the originating request. The outbox poller extracts this when
  │     enqueuing the BullMQ job — never generates a fresh one.
  │
  └─► Response to client

BullMQ Worker (job processor)
  ├─ Extract job.data._meta.correlationId
  ├─ jobLogger = logger.child({ correlationId, tenantId, jobId, jobName })
  ├─ All processing logs auto-include correlation
  └─ DB queries traced via OTel
```

### Context propagation: AsyncLocalStorage

Use Node.js native `AsyncLocalStorage` (stable since Node 16) — no external dependency (`cls-hooked` is deprecated).

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  correlationId: string;
  tenantId: string;
  userId?: string;
  logger: pino.Logger;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
```

## 6. GDPR Log Compliance

### 6.1 PII Redaction (defense in depth)

Three layers of protection:

1. **Pino `redact` option** (**implemented**) — strips known PII paths from all log output. The redact list is owned by a single shared constant (`PINO_REDACT_PATHS` in `packages/shared/src/constants/pino-redact.ts`), imported by API (`packages/api/src/server.ts` + `keycloak-admin.ts`), Worker (`packages/worker/src/lib/logger.ts`), and Relay (`packages/relay/src/lib/logger.ts`). Centralisation means a new sensitive field is added in exactly one place — otherwise PII policy drifts across services (issue #56).
   - Auth / session: `req.headers.authorization`, `req.headers.cookie`, `*.headers.authorization`, `*.headers.Authorization`
   - Secrets in request bodies: `body.password`, `body.token`, `body.client_secret`, `body.refresh_token`, `body.access_token`, `accessToken`, `*.accessToken`
   - Payment instruments: `body.iban`, `body.cardNumber`, `body.cvv`, `body.pan`
   - PII: `email`, `phone`, `firstName`, `lastName`, `address`, `nationalId`, `notes`, `customFields` (and the `body.*` / `*.*` variants so PII nested under a `constituent`, `volunteer`, or similar object is still caught)
2. **Custom serializers** — domain objects are logged with safe projections only (`{ id, type }`, never `{ email, name }`)
3. **Code review rule** — the Log Analyst agent flags any logged field that could contain PII
4. **Custom Pino serializers for domain objects** — register serializers for `constituent`, `volunteer`, `donation` objects that return only safe projections (`{ id, type }`). This prevents PII leakage even if developers accidentally log full domain objects (e.g., in error handlers or catch blocks).

### 6.2 Retention Policy

| Log type | Retention | Deletion method |
|----------|-----------|-----------------|
| Application logs (info/warn) | 90 days | Loki retention policy / log rotation |
| Error logs | 1 year | Loki retention policy |
| Security audit logs (DB table) | 7–10 years | DB scheduled job with anonymization |
| Debug/trace (per-tenant override) | 7 days max | Auto-expire, never persisted to long-term |
| Access logs | 90 days | Log rotation |

### 6.3 Right to Erasure (Art. 17)

- **Log files/streams**: retention-based deletion is the accepted approach (DPAs accept this as proportionate)
- **`audit_log` table** (name TBD in Phase 1 — see §7.3 reconciliation note): anonymize `actor_id`, `target_entity`, `ipHash`, `user_agent`, and PII within `changes` JSONB `before`/`after` diffs after retention period via scheduled job
- **Prevention > deletion**: do not store PII in logs in the first place

> **Exception**: `gdpr_consent_log.ip_address` (doc-03) retains raw IP. Lawful basis: proof of consent per GDPR Art. 7 requires recording the IP from which consent was given. The `audit_logs.metadata` JSONB always uses hashed IP — these are distinct storage contexts.

### 6.4 Special JSONB fields

Several JSONB columns across the schema require special GDPR handling because their contents are dynamic or free-text:

- **`outbox_events.payload`** — may contain full entity snapshots including PII. Must be included in the PII redaction spec (apply `sanitizeAuditDiff` before logging payload contents) or excluded from Pino log output entirely.
- **`custom_fields` JSONB** on `constituents`, `donations`, `volunteer_profiles`, and other entities — contains arbitrary tenant-defined data whose schema is unknown at build time. Exclude from logging entirely (cannot redact unknown schemas). Add `body.customFields`, `body.customFields.*`, `body.custom_fields`, `body.custom_fields.*` to Pino redact paths.
- **`constituent_relationships.notes`** — free-text field that may contain PII. Add `body.relationships[*].notes` to Pino redact paths.
- **`body.notes`** — free-text notes fields on donations, grants, case notes, etc. Add to Pino redact paths.

## 7. Security Audit Trail

> **Reconciliation note — `pg_audit` vs `audit_logs`**: Doc-02 lists the `pg_audit` PostgreSQL extension. This provides **database-level** change tracking (DDL/DML statements) as a safety net and compliance backstop. The custom `audit_logs` Drizzle table defined below provides **application-level** structured audit events with business semantics (who did what, with before/after diffs). They are complementary: `pg_audit` catches changes that bypass the application layer; `audit_logs` provides rich, queryable, tenant-scoped business context.

### 7.1 Dual approach

1. **Structured `audit_logs` table** in PostgreSQL — queryable, exportable, retainable for 7+ years
2. **Pino log lines with `audit: true` flag** — for real-time alerting via Loki/Grafana

### 7.2 Events catalog

| Category | Events | Audit table | Pino log |
|----------|--------|-------------|----------|
| Authentication | login_success, login_failure, logout, password_reset, mfa_toggle | Yes | Yes |
| Authorization | permission_denied, role_changed, rbac_violation | Yes | Yes (warn) |
| Data access | record_viewed, export_triggered, bulk_download | Yes | No (too noisy) |
| Data mutation | contact.created/updated/deleted, donation.recorded | Yes | Yes |
| GDPR | consent_recorded/withdrawn, export_requested, erasure_requested | Yes | Yes |
| Admin | tenant_settings_changed, user_invited/removed, api_key_rotated | Yes | Yes |
| Security | rate_limit_hit, cors_violation, invalid_jwt, ip_blocklist | Yes | Yes (warn) |
| AI actions | ai.suggestion_generated, ai.action_executed, ai.action_blocked, ai.guard_denied | Yes | Yes (info for generated/executed, warn for blocked/denied) |
| Migration | migration.started, migration.batch_loaded, migration.validation_error, migration.completed | Yes | Yes |

### 7.3 Audit log schema

See Log Analyst agent for full Drizzle schema. Key design decisions:

- **UUID v7 primary key** (project convention)
- **`changes` JSONB column** — stores `{ before, after }` diff with PII redacted
- **`metadata` JSONB column** — SHA-256 truncated hash of IP (`ipHash`), correlationId, user-agent (truncated). Raw IP is never stored in `audit_logs` — use hashed IP for forensic correlation without GDPR exposure.
- **Partitioned by `created_at`** (monthly range). Glacier/archive after 12 months.
- **Composite index** on `(tenant_id, action, created_at DESC)` for tenant-scoped queries
- **RLS-protected** — tenants can only query their own audit logs

> **Schema reconciliation (Phase 1 task)**: Doc-03 calls the table `audit_log` (singular) and uses `entity_type`/`entity_id` + separate `before_state`/`after_state` columns. This document uses `resourceType`/`resourceId` (Drizzle camelCase) and a single `changes: { before, after }` JSONB (avoids null ambiguity, more flexible). **Canonical table name will be decided in Phase 1 Drizzle schema baseline** — all references throughout the codebase must be consistent. Track as an open question in doc-10.

### 7.4 Change diff sanitization

The `changes` JSONB column stores `{ before, after }` diffs of entity mutations. **The service layer must sanitize these diffs before inserting into `audit_logs`** — this is NOT Pino's job (Pino redacts log output; audit diffs are written directly to the database).

**Pattern**: Define a `sanitizeAuditDiff(entityType, changes)` utility in `packages/shared` that:

1. Accepts the entity type and the raw `{ before, after }` diff
2. Strips PII fields using the same canonical field list as the Pino redact paths (e.g., `firstName`, `lastName`, `email`, `phone`, `address`, `iban`, `nationalId`, `emergencyContactName`, `emergencyContactPhone`, `dbsReference`)
3. Replaces stripped values with `'[REDACTED]'`
4. Returns the sanitized diff for DB insertion

This ensures PII never enters the `audit_logs` table, even if a developer forgets to exclude sensitive fields from the diff. The canonical PII field list is maintained in one place and shared between Pino redact config and this utility.

## 8. Performance Observability

### 8.1 Thresholds

| Metric | Warn | Error | Source |
|--------|------|-------|--------|
| API request p99 | > 300 ms | > 1 000 ms | Fastify `reply.elapsedTime` |
| DB query duration | > 500 ms | > 2 000 ms | OTel instrumentation-pg spans |
| BullMQ job duration | > 30 s | > 120 s | `job.finishedOn - job.processedOn` |
| Queue backlog (waiting) | > 1 000 | > 5 000 | `queue.getJobCounts()` periodic check |
| Queue failed jobs | > 100 | > 500 | `queue.getJobCounts()` periodic check |

> **Threshold semantics**: Warn thresholds are aligned to doc-02 NFR targets. When warn fires, the NFR is breached. When error fires, the system is degraded.

### 8.2 Slow query detection

OpenTelemetry `instrumentation-pg` auto-records query duration as span attributes. For Drizzle-level logging, use a custom `LogWriter` that emits to Pino at `debug` level (never `info` — too noisy).

### 8.3 Queue health monitoring

A BullMQ repeatable job runs every 60s, logs queue metrics at `info` level, and emits `warn` when thresholds are exceeded.

## 9. Testing Observability

### 9.1 Test logger

```typescript
// packages/shared/src/test-utils/logger.ts
import pino from 'pino';

export const testLogger = pino({
  level: process.env.DEBUG ? 'debug' : 'silent',
  transport: process.env.DEBUG
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
```

- Tests run silent by default (no noise in CI)
- Set `DEBUG=1` to enable debug output for a failing test
- Inject `testLogger` into services under test

### 9.2 Log assertion pattern

For audit log tests, pipe Pino to a `PassThrough` stream and assert on parsed JSON lines:

```typescript
const logLines: object[] = [];
const stream = new PassThrough();
stream.on('data', (chunk) => logLines.push(JSON.parse(chunk.toString())));
const logger = pino({ level: 'info' }, stream);

// ... run service method ...

const auditLine = logLines.find((l: any) => l.msg === 'donation recorded');
expect(auditLine).toHaveProperty('tenantId', 't_1');
expect(JSON.stringify(auditLine)).not.toContain('donor@example.com'); // no PII leak
```

### 9.3 Flaky test debugging

When a test is flaky:
1. Re-run with `DEBUG=1` to capture full log output
2. Check `correlationId` to trace the exact request flow
3. Check `tenantId` isolation — flaky tests often share state between tenants
4. Check BullMQ job logs — race conditions between API response and async worker

### 9.4 Redact path coverage test

Maintain a canonical PII field list derived from the Drizzle schema (all columns marked as PII in the `constituents`, `volunteer_profiles`, `households`, `gdpr_consent_log`, and `constituent_relationships` tables). Write a test that:

1. Imports the canonical PII field list
2. Imports the Pino redact paths from the shared config
3. Asserts that every PII field has a corresponding Pino redact path
4. Fails when a new PII column is added to the Drizzle schema without a matching redact path

This prevents PII redaction drift: when a developer adds a new PII column, the test breaks until the redact paths are updated.

## 10. Agent Rules — Cross-Agent Logging Enforcement

The following rules should be added to existing agents to enforce logging standards:

### MVP Engineer

| Rule | Description |
|------|-------------|
| Use `req.log` for all API route logging | Never create standalone Pino instances in route handlers |
| Propagate `_meta` in BullMQ jobs | Always include `{ correlationId, tenantId, userId }` in job data |
| No `console.log` | Use injected logger everywhere |
| Log business events at `info` | Donation recorded, contact created, campaign launched |
| Log errors with `{ err }` object | `req.log.error({ err }, 'description')` — Pino serializes Error natively |

### QA Engineer

| Rule | Description |
|------|-------------|
| Use `testLogger` from shared test utils | Silent by default, verbose with `DEBUG=1` |
| Assert no PII in log output | Pipe Pino to stream, assert `JSON.stringify` has no email/phone/name |
| Test audit log entries | Verify `audit_logs` table has correct entries after mutations |
| Test correlation propagation | Verify child loggers carry `correlationId` through the chain |

### Security Architect

| Rule | Description |
|------|-------------|
| Review Pino `redact` paths quarterly | New PII fields = new redact paths |
| Verify audit log retention job | Scheduled anonymization runs, respects 7-year minimum |
| Check Sentry `beforeSend` PII stripping | No auth tokens, cookies, or PII in Sentry events |
| Validate RLS on `audit_logs` table | Tenants must not see each other's audit trails |

### Platform Architect

| Rule | Description |
|------|-------------|
| OTel instrumentations: fastify + pg + ioredis + undici only | No auto-instrumentations-node (too broad) |
| Grafana Loki retention config | Match retention policy from this document |
| Docker log driver: json-file with max-size | Prevent disk exhaustion on self-hosted |
| OTel Collector resource attributes | `service.name`, `service.version`, `deployment.environment` |

### API Contract Designer

| Rule | Description |
|------|-------------|
| `X-Request-Id` header in all API responses | Document in OpenAPI spec |
| Error responses include `correlationId` | RFC 9457 `instance` field = correlation ID |
| No PII in error detail messages | Error messages are logged — PII would leak |

### Data Architect

| Rule | Description |
|------|-------------|
| `audit_logs` table in shared schema | Include in Drizzle schema baseline |
| Composite index `(tenant_id, action, created_at DESC)` | Required for tenant-scoped audit queries |
| JSONB `changes` column uses redacted diffs | Never store raw PII in before/after |

## 11. Implementation Phases

| Phase | Scope | Priority |
|-------|-------|----------|
| **Phase 1 — Skeleton** | ~~Pino setup in shared package, Fastify logger config, correlation ID plugin, PII redact paths, `testLogger` util~~ **Done** — Pino with redaction implemented in API (`server.ts`), Worker (`lib/logger.ts`), and Relay (`lib/logger.ts`). TypeBox env validation in all three packages. | P0 ✅ |
| **Phase 1 — Skeleton** | `audit_log` Drizzle schema + migration (canonical table name to be decided in Phase 1) | P0 |
| **Phase 1 — Skeleton** | AsyncLocalStorage context propagation | P1 |
| **Phase 2 — Core modules** | Audit log entries on all mutations (transactional outbox) | P0 |
| **Phase 2 — Core modules** | BullMQ job lifecycle logging with correlation | P0 |
| **Phase 2 — Core modules** | Slow query / slow request detection | P1 |
| **Phase 3 — Launch** | SaaS: OTel Collector → Scaleway Cockpit config · Self-hosted: Grafana Loki + Promtail deployment | P0 |
| **Phase 3 — Launch** | OTel SDK + instrumentations + Tempo | P1 |
| **Phase 3 — Launch** | Sentry integration (optional) | P2 |
| **Phase 3 — Launch** | Queue health monitoring repeatable job | P1 |
| **Phase 4+** | Per-tenant log level override | P2 |
| **Phase 4+** | Tenant-facing audit log viewer (UI) | P2 |

## 12. Package Dependencies

### Install in Phase 1 (shared + api)

```
pino@^10
pino-pretty@^13            # devDependency
```

### Install in Phase 2-3 (api + worker)

```
@opentelemetry/api@^1.9
@opentelemetry/sdk-node@^0.214
@opentelemetry/exporter-trace-otlp-http@^0.214
@opentelemetry/instrumentation-fastify@^0.57
@opentelemetry/instrumentation-pg@^0.66
@opentelemetry/instrumentation-ioredis@^0.62
@opentelemetry/instrumentation-undici@^0.24
pino-opentelemetry-transport@^3
```

### Install when deploying (infrastructure)

```
pino-loki@^3               # if shipping direct to Loki
```

### Do NOT install

- `winston` — redundant with Pino/Fastify
- `cls-hooked` — deprecated, use `AsyncLocalStorage`
- `morgan` — Express-only
- `@opentelemetry/auto-instrumentations-node` — too broad
- `@sentry/node` without GDPR `beforeSend` — PII would leak to Sentry

## 13. Observability Gaps — Future Work

The following items are not covered by this document and need separate specification:

- **`givernance-migrate` ETL tool** — needs its own Pino setup, correlation ID strategy (no incoming HTTP requests to derive from), and structured progress logging for batch operations (rows imported, validation errors, elapsed time).
- **Next.js SSR** — needs Pino configuration for server-side rendering, error boundary logging (React `ErrorBoundary` → Pino), and client-side error capture strategy.
- **Outbound webhook delivery** — needs a logging spec covering delivery attempts, failures, retry counts, circuit-breaking state transitions, and response status codes.
- **Cron / repeatable jobs** — need a `batchCorrelationId` strategy. These are system-initiated (not request-initiated), so there is no incoming `X-Request-Id`. Generate a UUIDv7 at job creation time and propagate through all downstream work.
- **OTel resource attributes** — should include `service.instance.id` (unique per replica) for multi-replica SaaS deployment on Scaleway. This enables per-instance log filtering in Grafana Cockpit when debugging replica-specific issues.
