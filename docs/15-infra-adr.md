# 15 — Architecture Decision Records

This document captures key architectural decisions for Givernance, recording context, rationale, and tradeoffs for future reference. It focuses on presenting the *currently active* decisions.

---

## ADR-001: Modular Monolith over Microservices

- **Status**: Accepted
- **Date**: 2025-12
- **Deciders**: Magino (founder/architect)

### Context

Givernance targets NPOs with 2–200 staff. The system must support multi-tenancy, GDPR compliance, and a growing feature set (contacts, donations, grants, cases, volunteers, reporting). The team is a solo developer in Phase 0 with plans to grow to 3–5 engineers by Phase 2.

### Decision

Use a **modular monolith** architecture with well-defined bounded contexts, deployed as a single process, with the option to extract modules into services later.

### Rationale

- A single deployment unit minimizes operational complexity for a small team
- Bounded contexts enforce separation at the code level (module boundaries, dependency rules) without the overhead of network calls
- Shared database with schema-per-module enables transactional consistency where needed
- Migration to microservices is possible later by extracting modules along existing boundaries
- Operational cost of Kubernetes + service mesh + distributed tracing for microservices is disproportionate for the current team size and user base

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Microservices from day one | Independent scaling, team autonomy | Massive ops overhead for solo dev, distributed transactions, complex debugging | Rejected |
| Traditional monolith (no module boundaries) | Simple to start | Becomes tangled quickly, hard to extract later | Rejected |
| **Modular monolith** | Clean boundaries, single deployment, extractable | Requires discipline to maintain module boundaries | **Selected** |

### Consequences

- Module boundaries must be enforced via linting rules and code review
- Inter-module communication uses in-process function calls (not HTTP/gRPC)
- Database migrations are scoped per module but run in a single migration pipeline
- Phase 4+ may extract high-traffic modules (e.g., reporting, AI) into separate services

---

## ADR-002: TypeScript Full-Stack over Go Backend

- **Status**: Accepted
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

Givernance's frontend is already TypeScript (Next.js 15). The original backend was planned in Go 1.23 for raw performance and small binary size. As a Phase 0 project with a single developer, the cost of context-switching between Go (backend) and TypeScript (frontend) is significant. The team needs to maximize velocity and minimize cognitive overhead.

### Decision

Use **TypeScript (Node.js 22 LTS + Fastify 5)** for the backend, creating a full-stack TypeScript monorepo managed with pnpm workspaces.

### Rationale

- **Single language across the stack** → eliminates context switching for a solo/small team
- **Shared types** between frontend (Next.js) and backend (Fastify) via `packages/shared` — a single TypeBox schema defines API contract, request validation, OpenAPI generation, and form validation
- **TypeScript type safety + TypeBox runtime validation** covers Go's compile-time safety advantage with the added benefit of runtime enforcement and native Fastify JSON serialization performance
- **Fastify 5 benchmarks at ~77,000 req/s** on Node.js 22 — well above the target NPO workload of ~500 req/s at peak (200-staff org, 50 concurrent users)
- **BullMQ** (TypeScript-native) is a direct functional equivalent to Asynq (Go) — both Redis-backed, both support cron, retries, and concurrency control
- **Drizzle ORM** provides Go-like type safety for SQL queries in TypeScript, with explicit SQL semantics (no magic)
- **Ecosystem advantage**: TypeScript has a significantly larger developer pool than Go; easier hiring for a European NPO-focused startup
- **Immediate benefit**: TypeBox schemas reused from API validation in Next.js forms create a single source of truth for data contracts

> **Implementation note (2026-04-14)**: Zod was initially selected but **abandoned during Phase 1** in favor of `@sinclair/typebox`. TypeBox provides native Fastify integration (JSON serialization + OpenAPI 3.1 schema generation without conversion), better performance (no runtime Zod→JSON Schema transformation), and direct Swagger/OpenAPI compatibility. All validators in `packages/shared/src/validators/` and all route schemas in `packages/api/` use TypeBox exclusively.

### Tradeoffs

| Option | Pros | Cons | Verdict |
|---|---|---|---|---|
| Go 1.23 (original plan) | Best raw performance (~300k req/s), compiled binary, ~10 MB Docker image, low memory footprint | Separate language from frontend, no shared types, smaller developer pool in EU, no type sharing with Next.js | Rejected |
| **TypeScript + Fastify 5** | Full-stack TS, shared types via monorepo, large ecosystem, ~77k req/s sufficient for target workload | Runtime overhead vs Go, GC pauses possible at scale, larger Docker image (~150 MB Alpine) | **Selected** |
| Python (FastAPI) | Easy ML/AI integration, familiar to data scientists | ~8k req/s (too slow for API layer), no frontend type sharing, GIL limitations | Rejected |
| Bun runtime | Faster than Node.js (~2x in benchmarks), built-in TypeScript support | Less mature ecosystem, fewer production deployments, limited corporate adoption | Re-evaluate at Phase 4 |

### Consequences

- Docker image will be larger (~150 MB vs ~10 MB for Go) — mitigated by Alpine base image + multi-stage build
- Memory usage higher than Go (~100–200 MB vs ~20–50 MB) — mitigated by PgBouncer connection pooling, Redis caching, and horizontal scaling at Phase 3+
- CPU-bound tasks (PDF generation, large CSV exports) may need worker threads or dedicated BullMQ processors with sandboxed execution
- **Performance re-evaluation at Phase 3**: load test against NFRs (p99 < 200 ms, 500 req/s sustained) — if Node.js 22 falls short, consider Bun runtime or extracting hot paths
- All existing architecture documents (02-reference-architecture, 04-business-capabilities) must be updated to reflect the TypeScript stack

---

## ADR-003: Drizzle ORM over Raw SQL or Prisma

- **Status**: Accepted
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

Givernance requires type-safe database access in TypeScript with PostgreSQL 16. The data model relies on PostgreSQL-specific features including Row-Level Security (RLS) with `SET LOCAL` per transaction for multi-tenancy, `uuid-ossp` for primary keys, and `pg_trgm` for fuzzy search.

### Decision

Use **Drizzle ORM** for database access and **Drizzle Kit** for schema migrations (replacing golang-migrate from the original Go plan).

### Rationale

- **Closest to SQL**: Drizzle's query builder maps 1:1 to SQL semantics — no "magic" abstraction layer, what you write is what executes
- **Full type inference**: Schema definitions generate TypeScript types automatically; query results are fully typed without code generation steps
- **Drizzle Kit migrations**: Schema-driven migration generation replaces hand-written SQL migrations (golang-migrate), with the option to customize generated SQL
- **No N+1 magic**: Relations are explicit, not auto-loaded — prevents accidental performance issues common in ORMs like Prisma and TypeORM
- **PostgreSQL-native**: Works with RLS (`SET LOCAL` within transactions), `pg_trgm` operators, `uuid-ossp`, and raw SQL escape hatches when needed
- **Lightweight**: No code generation step, no heavy runtime, no binary dependency

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Prisma** | Large community, excellent DX for simple CRUD | Heavy code generation step, poor support for `RLS SET LOCAL` per-transaction, Prisma Client binary (~15 MB), schema language is not TypeScript | Rejected |
| **TypeORM** | Mature, decorator-based entity definitions | Poor TypeScript type inference, decorator-heavy syntax, declining maintenance activity | Rejected |
| **Raw pg (node-postgres)** | Maximum control, no abstraction overhead | No type safety for queries, verbose boilerplate for every query, manual migration management | Rejected |
| **Kysely** | Type-safe query builder, lightweight | Less mature migration tooling, smaller ecosystem than Drizzle | Considered — revisit if Redis is removed from stack |
| **Drizzle ORM** | SQL-like API, full type inference, Drizzle Kit migrations, PostgreSQL-native features | Younger project than Prisma, smaller community | **Selected** |

### Consequences

- Schema definitions live in `packages/shared/src/schema/` as TypeScript files — these are the source of truth for both migrations and application types
- Migration workflow: modify schema → `drizzle-kit generate` → review SQL → `drizzle-kit migrate`
- RLS enforcement pattern: The API uses the `givernance_app` PostgreSQL role (NOBYPASSRLS) and wraps queries in `withTenantContext(orgId, callback)`, which calls `set_config('app.current_org_id', orgId, true)` inside a Drizzle transaction. A global Fastify `preHandler` with session-level `SET LOCAL` was explicitly rejected as unsafe with PgBouncer transaction-mode pooling. See [03-data-model.md §4](./03-data-model.md) for the full 3-role pattern.
- Team members must learn Drizzle's API (smaller community means fewer Stack Overflow answers, but official docs are comprehensive)

---

## ADR-004: Job Queue System (BullMQ) — Superseded by ADR-008

- **Status**: Superseded by ADR-008
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

Givernance required a reliable background job system for: email dispatch, PDF/report generation, Salesforce migration ETL, GDPR data export/deletion, scheduled donation reminders, and AI processing pipelines. The system needed to support cron scheduling, retry with backoff, concurrency control, and job prioritization. Redis was already in the stack for caching and rate limiting.

### Decision (Superseded)

Initially, **BullMQ 5** was selected as the background job queue, backed by the existing Redis instance.

### Rationale (Superseded)

- **TypeScript-native**: First-class TypeScript support with generics for type-safe job data (`Queue<DonationReceiptJob>`)
- **Redis-backed**: Reused the same Redis instance already required for caching, rate limiting, and session storage — no additional infrastructure
- **Feature-rich**: Supported repeatable jobs (cron), delayed jobs, job prioritization, rate limiting per queue, sandboxed processors (separate Node.js processes), and flow/parent-child job dependencies
- **Battle-tested**: Used in production by companies processing millions of jobs/day; mature ecosystem with BullBoard for monitoring
- **Direct replacement for Asynq**: Functional parity with the Go-based Asynq library originally planned — both are Redis-backed with similar APIs for enqueue, process, retry, and cron

### Rejected Alternatives (Superseded)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Asynq (Go)** | Lightweight, Go-native | Requires Go runtime, cannot share types with TypeScript stack | Rejected (Go stack abandoned) |
| **Agenda (Node.js)** | MongoDB-backed, simple API | MongoDB dependency (not in stack), less active maintenance | Rejected |
| **pg-boss** | PostgreSQL-backed (no Redis needed) | Lower throughput than Redis-backed solutions, less feature-rich than BullMQ | Considered — revisit if Redis is removed from stack |
| **BullMQ 5** | TypeScript-native, Redis-backed, full-featured, active maintenance | Redis dependency (already in stack), memory usage for large job payloads | **Selected** |

### Consequences (Superseded)

- Redis became a critical infrastructure component (was optional for caching, now required for job queue) — had to be included in HA planning from Phase 2
- Job definitions lived in `apps/api/src/jobs/` with shared job data types in `packages/shared`
- BullBoard dashboard integrated into the admin panel for job monitoring (Phase 1)
- Large job payloads (e.g., Salesforce migration batches) had to store data in PostgreSQL and pass only IDs through Redis to avoid memory pressure

---

## ADR-005: NATS JetStream — Deferred to Phase 4

- **Status**: Deferred
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

The original architecture (doc 02) included NATS JetStream as a domain event bus starting from Phase 0. However:

- The project uses a **modular monolith** with a **single worker process** — there is exactly one publisher and one consumer
- Redis + BullMQ is already required for async job processing (PDF generation, bulk email, GDPR erasure, etc.)
- Running a production-grade NATS cluster requires 3 nodes for HA — significant ops overhead for a pre-revenue product

With the move to a TypeScript modular monolith using BullMQ for async processing, the immediate need for a dedicated message broker is reduced. NATS JetStream's primary advantages — multi-subscriber fan-out, event replay, and cross-service communication — are not required while all modules run in a single process.

### Decision

**Remove NATS JetStream from Phase 0–3.** Use the **transactional outbox → BullMQ (Redis)** pipeline for all domain event and async job processing.

Flow:
```
DB transaction (mutation + outbox_events row, status='pending')
  → givernance-relay polls (500ms, SELECT ... FOR UPDATE SKIP LOCKED)
  → BullMQ enqueue (Redis)
  → givernance-worker (at-least-once, retries, dead-letter)
```

### Rationale

| Option | Verdict |
|---|---|
| NATS JetStream from Phase 0 | ❌ One publisher + one consumer — 3-node cluster for zero architectural benefit |
| Postgres LISTEN/NOTIFY | ❌ No durability, no dead-letter, no retry semantics |
| BullMQ (Redis) via outbox | ✅ At-least-once, retries, DLQ, job inspection, already required |
| Direct in-process call | ❌ Loses outbox durability guarantee (dual-write risk) |

BullMQ provides natively: at-least-once delivery, configurable retry with backoff, dead-letter queues, job deduplication, cron scheduling, and BullBoard web UI for job inspection. No separate message broker needed.

The transactional outbox pattern intentionally abstracts the publish backend. Switching from BullMQ-direct to NATS in Phase 4 requires changing **one file** (`packages/shared/src/events/publisher.ts`) — zero domain logic changes.

### Reintroduction Criteria (Phase 4+)

- A second autonomous service is extracted from the monolith and needs to consume domain events independently
- Outbound webhooks require multi-subscriber fan-out at scale (>1,000 active webhook endpoints)
- Event replay is needed for audit enrichment or system debugging
- Team size exceeds 4 engineers (shared Redis job queue coordination cost increases)
- Event sourcing patterns for specific modules (e.g., donation ledger)

### Consequences

- ✅ Phase 0 infrastructure: 8 services instead of 9 (simpler Docker Compose, faster local dev)
- ✅ No NATS operational knowledge required until Phase 4
- ✅ Webhook fan-out handled by BullMQ retry mechanism (sufficient for <1,000 webhooks/org at Phase 0-3 scale)
- ⚠️ No event replay in Phase 0-3 — if needed, query `outbox_events` table directly
- ⚠️ Multi-subscriber fan-out not available until Phase 4 — enforce single-consumer contract in outbox design
- Module event contracts should still be defined as TypeScript interfaces (in `packages/shared/events/`) to ease future NATS integration
- BullMQ becomes the sole async backbone — its Redis dependency must be treated as critical infrastructure

---

## ADR-007: Reject Convex.dev and Supabase as All-in-One Backend Replacements

- **Status**: Accepted
- **Date**: 2026-03-09
- **Deciders**: Magino (founder/architect)

### Context

Evaluated Convex.dev and Supabase as potential all-in-one backend platforms to reduce infrastructure complexity for Phase 0.

### Decision

Reject both as primary backend replacements. Supabase PostgreSQL remains a valid managed database option (equivalent to Neon.tech — see ADR-009).

### Rationale — Convex.dev rejected

Self-hosted Convex now exists (Docker + PostgreSQL backend, released Feb 2025). Still rejected because:

| Criterion | Assessment |
|---|---|
| Application-level RLS | ❌ Application-level RLS vs PostgreSQL native RLS — weaker security boundary for multi-tenant GDPR data |
| Data model fit | ❌ Document/reactive model doesn't map cleanly to relational NPO data (households→persons→donations→fund allocations) |
| Self-hosted HA | ❌ Single-machine by default for self-hosted, complex HA |
| Audit logs | ❌ Audit logs need external integration for self-hosted (not built-in — incompatible with 7-year GDPR retention requirement) |
| PostgreSQL extensions | ❌ pg_audit, pg_trgm extensions unavailable via Convex abstraction |
| EU data residency | ❌ Cloud-hosted Convex is US-only; self-hosted addresses this but introduces operational burden |
| Vendor lock-in | ❌ Proprietary query language, reactive model, and function format — even self-hosted uses Convex's proprietary stack |

**Status: Rejected.** Re-evaluate only if Phase 4 real-time requirements cannot be met by NATS JetStream.

### Rationale — Supabase all-in-one rejected

| Component | Assessment |
|---|---|
| Self-hosted Supabase | ❌ 12+ containers (Kong, GoTrue, PostgREST, Realtime, Storage, Studio, etc.) — more complex than the current stack |
| Supabase Auth (GoTrue) | ❌ Missing: SAML 2.0 bridge, MFA enforcement by role, magic-link for volunteers, brute-force protection by role — all specified in auth requirements |
| Supabase Realtime | ❌ Postgres LISTEN/NOTIFY: no durability, no dead-letter, no at-least-once semantics — insufficient to replace the transactional outbox |
| Supabase PostgreSQL only | ✅ Valid as managed Postgres (same as Neon.tech) — see ADR-009 |

### Consequences

- ✅ Keycloak retained — full auth feature set preserved (SAML 2.0, MFA, magic-link, brute-force protection)
- ✅ PostgreSQL with RLS, pg_audit, pg_trgm retained — GDPR tenant isolation and audit patterns preserved
- ✅ Self-hosted deployment path preserved — no cloud-only dependency
- ✅ TypeScript full-stack retained — shared types and monorepo benefits preserved (see ADR-002)
- ⚠️ Auth infrastructure requires self-hosting Keycloak — adds one container to manage in all deployment modes

---

## ADR-008: Job Queue System (pg-boss) 

- **Status**: Accepted
- **Date**: 2026-03 (Updated: 2026-04-08)
- **Deciders**: Magino (founder/architect)
- **Context**: The previous stack used BullMQ 5 + Redis for job queue processing. Redis was used for: (1) job queue backend, (2) rate limiting counters, (3) session cache. This decision aims to remove Redis, simplifying deployment and reducing infrastructure services.
- **Decision**: Replace BullMQ + Redis with **pg-boss** (PostgreSQL-backed job queue) for Phase 0-3.
- **Rationale**:
  - pg-boss stores jobs in a dedicated `pgboss` schema in PostgreSQL — zero new infrastructure dependency
  - All job state (pending, active, completed, failed, retry) visible via standard SQL — directly monitorable without a separate dashboard
  - Transactional job creation: enqueue a job inside the same DB transaction as the mutation — stronger delivery guarantee than outbox pattern
  - TypeScript-native, well-maintained (1M+ weekly downloads), production-proven
  - Eliminates Redis from Phase 0-3 entirely (rate limiting can use in-memory or a simple PG table)
  - Scaleway Managed PostgreSQL EU (ADR-009) handles pg-boss jobs natively (just another schema)
  - **Code reduction**: removes `packages/worker/src/queues/index.ts` Redis config, simplifies connection management
- **Consequences**:
  - Slight performance difference vs Redis (PG-based queue has higher latency per job ~5-20ms vs ~1ms) — acceptable for NPO workloads (no sub-millisecond job SLA)
  - Redis re-introduction justified at Phase 4 only if job throughput exceeds ~1,000 jobs/min sustained
  - Rate limiting: use `express-rate-limit` with PostgreSQL store (or simple in-memory for Phase 0)
- **Rejected alternatives**:
  - **BullMQ + Redis** (superseded): required running Redis — one more infra service to operate, monitor, and backup
  - **Inngest**: hosted only, adds vendor dependency
  - **Trigger.dev**: interesting but adds complexity for Phase 0
- **Migration path from BullMQ**: Direct swap in `packages/worker/`. Same job types, same processors — only the queue client changes (BullMQ Queue → pg-boss). Schema: `packages/shared/src/jobs/index.ts` types stay identical.

---

## ADR-009 — Scaleway as Primary SaaS Managed Cloud Provider

**Status**: Accepted
**Date**: 2026-03-30
**Deciders**: Magino (founder/architect)
**Supersedes**: ADR-006 (removed)

### Context

ADR-006 previously selected a multi-vendor cloud setup. This decision supersedes that by consolidating all managed infrastructure under a single European cloud provider.

The beneficiary data processing requirement (GDPR Art. 9 special category data) requires that AI inference for case notes and medical/social status run on EU infrastructure with no data leaving EU jurisdiction. The original plan specified self-hosted Ollama on a VPS — adding operational burden and GPU procurement complexity.

A holistic evaluation was conducted to identify a single European cloud provider covering compute, managed databases, cache, storage, observability, and AI inference in an `integrated platform under a single GDPR-native contract`.

### Options evaluated (Summary)

Scaleway was compared against UpCloud, OVH Cloud, and Railway across criteria like headquarters, regions, managed services (PostgreSQL, Redis, Object Storage), integrated observability, managed AI inference in EU, GDPR/DPA, pricing transparency, and Keycloak support. Scaleway emerged as the most comprehensive solution.

### Decision

**Scaleway** is selected as the primary cloud provider for the Givernance SaaS managed offering, replacing the tri-vendor setup (Neon.tech + Upstash + Cloudflare R2) from the superseded ADR-006.

### Rationale

1.  **Cockpit (Grafana + Loki + Mimir + Tempo)**: Unified observability platform included natively. Scaleway-native metrics and logs are free; custom log ingestion billed at volume. Eliminates the need to self-host Grafana/Loki stacks or pay for a separate SaaS observability tool.
2.  **Managed Inference EU (Mistral, Llama 3.1)**: Scaleway's Generative APIs provide pay-per-token and dedicated GPU inference endpoints hosted exclusively in EU datacenters. This directly replaces the self-hosted Ollama requirement for beneficiary data (GDPR Art. 9) — no GPU procurement, no ML ops overhead, full GDPR coverage under the Scaleway DPA.
3.  **Single European cloud, single DPA**: All infrastructure (compute, database, cache, storage, inference, observability) operates under one GDPR-native contract from a French company. Eliminates the multi-vendor DPA management overhead.
4.  **Managed PostgreSQL, Redis, Object Storage**: Direct functional equivalents to previously considered providers. PostgreSQL supports all required extensions (uuid-ossp, pgcrypto, pg_trgm, ltree, pg_audit). Redis covers BullMQ job queue + rate limiting (though now pg-boss is the primary queue). Object Storage is S3-compatible.
5.  **Predictable fixed pricing**: Hourly billed VMs and managed services with published pricing. No cold-start latency, no per-request surprise billing.
6.  **Keycloak compatibility**: Scaleway VMs support self-hosted Keycloak in all configurations.

### Cost estimates (Summary)

Detailed cost estimates for Phase 0 (Dev/staging), Phase 1 (1 NPO pilot), and Phase 1 extended (5–10 NPOs) are provided, ranging from ~67€/month for dev/staging to ~458€/month for extended Phase 1. Optional AI inference costs (pay-per-token or dedicated GPU) are also detailed.

### Consequences

- ✅ **Replaces** Neon.tech → Scaleway Managed PostgreSQL EU
- ✅ **Replaces** Upstash Redis → Scaleway Managed Redis EU
- ✅ **Replaces** Cloudflare R2 → Scaleway Object Storage (S3-compatible API)
- ✅ **Replaces** self-hosted Ollama → Scaleway Generative APIs (Mistral, Llama 3.1) for beneficiary data AI
- ✅ **Adds** Scaleway Cockpit: Grafana, Loki, Mimir, Tempo for observability
- ✅ **Single vendor DPA** replaces three separate DPAs
- ✅ Keycloak remains **self-hosted on Scaleway VMs**
- ⚠️ NATS JetStream remains **Phase 4+** — the BullMQ (now pg-boss) outbox pipeline is primary for Phase 0-3
- ⚠️ Self-hosted Docker Compose deployment (NPO on-premises) is **unchanged**

### Revisit criteria (Summary)

Criteria for revisiting include pricing changes, unsupported PostgreSQL extensions, stricter data sovereignty requirements, unacceptable AI latency, future NATS JetStream needs, or GPU inference demand.

---

## ADR-007: Reject Convex.dev and Supabase as All-in-One Backend Replacements (Updated Context)

- **Status:** Accepted
- **Date:** 2026-03-09 (Re-evaluated: 2026-04-08)
- **Deciders**: Magino (founder/architect)

### Context

Evaluated Convex.dev and Supabase as potential all-in-one backend platforms. Supabase PostgreSQL remains a valid managed database option as part of the Scaleway selection (ADR-009).

### Rationale — Convex.dev rejected

- **Application-level RLS**: Weaker security boundary for multi-tenant GDPR data vs PostgreSQL native RLS.
- **Data model fit**: Document/reactive model doesn't map cleanly to relational NPO data.
- **Self-hosted HA**: Complex HA for self-hosted setup.
- **Audit logs**: Requires external integration, incompatible with GDPR retention.
- **PostgreSQL extensions**: `pg_audit`, `pg_trgm` unavailable.
- **Vendor lock-in**: Proprietary query language and function format.

**Status: Rejected.** Re-evaluate only if Phase 4 real-time requirements cannot be met by NATS JetStream.

### Rationale — Supabase all-in-one rejected

- **Self-hosted complexity**: 12+ containers more complex than current stack.
- **Supabase Auth (GoTrue)**: Missing key auth requirements (SAML 2.0 bridge, MFA enforcement, magic-link, brute-force protection).
- **Supabase Realtime**: Insufficient for transactional outbox pattern (no durability, no dead-letter, no at-least-once).
- **Supabase PostgreSQL only**: Remains a valid managed Postgres option (comparable to Scaleway Managed PostgreSQL under ADR-009).

### Consequences

- ✅ Keycloak retained for full auth feature set.
- ✅ PostgreSQL with RLS, pg_audit, pg_trgm retained for GDPR tenant isolation and audit patterns.
- ✅ Self-hosted deployment path preserved.
- ✅ TypeScript full-stack retained.
- ⚠️ Auth infrastructure requires self-hosting Keycloak.

---

## ADR-011: Layered Service Architecture over MVC for Frontend

- **Status**: Accepted
- **Date**: 2026-04-16
- **Deciders**: Magino (founder/architect)

### Context

Givernance's frontend is a Next.js 16 App Router application (React 19, TypeScript) consuming a Fastify 5 REST API (ADR-002). The backend already enforces a clear modular monolith structure (ADR-001) with TypeBox schemas, Drizzle ORM, and PostgreSQL RLS. The frontend needs an equivalent architectural pattern that:

1. Provides clean separation of concerns between API communication, data shaping, domain logic orchestration, and rendering
2. Works naturally with React Server Components (RSC) and the App Router's file-based routing
3. Supports two distinct execution contexts — server-side (RSC, route handlers) and client-side (interactive components) — each with different auth token forwarding mechanisms
4. Avoids redundant abstraction layers that duplicate what the framework already provides

The classical MVC pattern was evaluated and found to be a poor fit for a React/Next.js App Router frontend.

### Decision

Use a **4-layer service architecture** for the Next.js frontend:

```
┌─────────────────────────────────────────────────┐
│  UI Layer                                       │
│  src/app/ (pages, layouts, route segments)       │
│  src/components/ (reusable React components)     │
│  ── renders data, delegates all API calls ──     │
├─────────────────────────────────────────────────┤
│  Services Layer                                  │
│  src/services/ (domain-specific orchestration)   │
│  ── class-based, ApiClient injected via ctor ──  │
│  ── e.g. DonationService, ContactService ──      │
├─────────────────────────────────────────────────┤
│  Domain Models Layer                             │
│  src/models/ (TypeScript interfaces)             │
│  ── frontend-specific shapes ──                  │
│  ── dates as ISO strings, not Date objects ──    │
├─────────────────────────────────────────────────┤
│  API Client Layer                                │
│  src/lib/api/ (typed fetch wrapper)              │
│  ── JWT from httpOnly cookies (server) ──        │
│  ── credentials: 'include' (client) ──           │
│  ── RFC 9457 error parsing ──                    │
└─────────────────────────────────────────────────┘
```

**State management** (part of this decision):

- **TanStack Query v5** for server data caching, deduplication, background refetching, and optimistic updates in Client Components
- **React Context** for cross-cutting concerns only: auth state, feature flags (`18-feature-flags.md`), AI mode (`13-ai-modes.md`)
- **No global state library** (Redux, Zustand, Jotai) — Server Components eliminate most client-side state; remaining interactive state is local to component trees

### Layer Responsibilities

**1. API Client (`src/lib/api/`)**

Two factory functions produce a typed fetch wrapper:

- `createServerApiClient()` — used in Server Components and route handlers; reads JWT from `cookies()` (Next.js `next/headers`)
- `createClientApiClient()` — used in Client Components; sends `credentials: 'include'` for browser-managed httpOnly cookies

Both factories share the same interface: typed `get<T>()`, `post<T>()`, `put<T>()`, `patch<T>()`, `delete<T>()` methods with automatic RFC 9457 error parsing into a structured `ApiError` type. Base URL is configured via `NEXT_PUBLIC_API_URL` (client, must point to public gateway/reverse proxy — never an internal service address) and `API_URL` (server, internal network — e.g., `http://api:8080`).

**Security requirements for the API Client layer:**

- **JWT cookie attributes**: Authentication tokens are stored in `httpOnly` + `Secure` + `SameSite=Strict` cookies. `SameSite=Strict` (not `Lax`) is required because `GET`-based state reads could leak data via cross-origin navigation.
- **CSRF protection**: The client API client attaches a CSRF token (double-submit cookie pattern) as an `X-CSRF-Token` header on all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`). The server validates the token matches the value in the CSRF cookie.
- **PII in error responses**: RFC 9457 error details parsed by the API Client must not be logged to browser console or forwarded to error tracking services if they contain PII. Error display uses only the `title` and `detail` fields through sanitized UI components.
- **TanStack Query cache hygiene**: The in-memory query cache may hold PII (donor names, emails, financial data). `gcTime` must be configured to minimize PII retention, and the cache must be explicitly cleared on logout via `queryClient.clear()`.

**2. Domain Models (`src/models/`)**

Frontend-specific TypeScript interfaces that represent API response shapes. These are **not** copies of the Drizzle schema from `@givernance/shared` — they reflect the serialized JSON contract:

- Dates are `string` (ISO 8601), not `Date`
- Monetary amounts are `number` (cents) or `string` (formatted), depending on the endpoint
- Nested relations are flattened or omitted per the API's response envelope

Models are pure types with no runtime code — they exist solely for type safety across services and components. See ADR-013 for the import boundary enforcement that ensures `packages/web` never imports Drizzle ORM types from `@givernance/shared/schema`.

**3. Services (`src/services/`)**

Class-based services with `ApiClient` injected via the constructor:

```typescript
class DonationService {
  constructor(private api: ApiClient) {}
  async list(orgId: string, filters: DonationFilters): Promise<PaginatedResponse<Donation>> { ... }
  async getById(orgId: string, id: string): Promise<Donation> { ... }
  async create(orgId: string, data: CreateDonationInput): Promise<Donation> { ... }
}
```

Constructor injection enables the same service class to work in both execution contexts — the caller provides the appropriate `ApiClient` factory. Services handle domain-specific orchestration: composing multiple API calls, transforming responses, and encapsulating business rules that are purely presentational (e.g., computing a donor's lifetime value from paginated donation history for a dashboard widget).

**4. UI (`src/app/` + `src/components/`)**

- `src/app/` — Next.js App Router route segments (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`). Server Components by default; fetch data via services with `createServerApiClient()`
- `src/components/` — reusable React components. Client Components that need data use TanStack Query hooks wrapping service calls with `createClientApiClient()`

### Why MVC Was Rejected

| MVC Layer | Next.js App Router Equivalent | Problem |
|---|---|---|
| **Controller** | Route segments (`page.tsx`, `layout.tsx`, `route.ts`) already dispatch requests based on URL — the App Router **is** the controller | Adding a controller layer creates a redundant dispatch abstraction over file-based routing |
| **View** | React components **are** the view — JSX is the template language | No template engine to abstract; a "View" layer separate from components is meaningless in React |
| **Model** | No ORM on the frontend — there is no local database to model | "Model" degenerates into API call wrappers, which is exactly what the Services + API Client layers provide with clearer naming |

MVC was designed for server-rendered applications where the controller receives HTTP requests, the model manages persistent state, and the view renders templates. In a React SPA/RSC hybrid, all three responsibilities are already handled by the framework — layering MVC on top adds indirection without adding separation.

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **MVC (Model-View-Controller)** | Familiar pattern, well-documented | Controller redundant with App Router routing, View redundant with React components, Model has no ORM to wrap — all three layers collapse into what the framework already provides | Rejected |
| **MVVM (Model-View-ViewModel)** | Clean data binding, good for complex forms | ViewModel pattern assumes two-way binding (Knockout, Angular) — React's unidirectional data flow makes ViewModels unnecessary; TanStack Query already manages the "ViewModel" concern (cached server state + loading/error states) | Rejected |
| **Feature-sliced architecture** (co-located per feature) | Strong co-location, scales to large teams | Premature for a 1–3 person team; fragments shared services and models across feature directories; harder to enforce consistent API client usage; revisit at Phase 4 if team exceeds 5 engineers | Rejected — revisit at scale |
| **No layering** (pages call `fetch()` directly) | Minimal abstraction, fast to start | JWT forwarding logic duplicated in every page/component, no RFC 9457 error handling consistency, no type safety on API responses, impossible to test business logic without rendering components | Rejected |
| **Layered service architecture** | Clean separation matching actual concerns (transport, shape, orchestration, rendering); works with both RSC and Client Components; testable services via DI; no redundant layers | Requires discipline to avoid services becoming "god classes"; slightly more boilerplate than direct fetch | **Selected** |

### Consequences

- ✅ API Client layer centralizes JWT forwarding, base URL configuration, and error parsing — no `fetch()` calls scattered across components
- ✅ Services are testable in isolation by injecting a mock `ApiClient` — no need to render React components to test API orchestration logic
- ✅ Domain Models provide a single source of truth for API response types on the frontend — TypeScript catches shape mismatches at compile time
- ✅ TanStack Query eliminates the need for Redux/Zustand — server state is cached, deduplicated, and background-refreshed without a global store
- ✅ React Context remains minimal (auth, feature flags, AI mode) — avoids the "everything in global state" anti-pattern
- ✅ Constructor injection of `ApiClient` into services makes the server/client boundary explicit — no accidental `cookies()` calls in Client Components
- ⚠️ Services must not grow into god classes — enforce one service per domain aggregate (e.g., `DonationService`, `ContactService`, `CampaignService`), matching the backend module boundaries from ADR-001
- ⚠️ Domain Models in `src/models/` will drift from `@givernance/shared` TypeBox schemas if the API contract changes — mitigate by generating frontend types from OpenAPI spec in Phase 2+
- ⚠️ Feature-sliced architecture should be re-evaluated if the team exceeds 5 engineers or the frontend exceeds ~40 routes (Phase 4+)

---

## ADR-012: shadcn/ui + TanStack Ecosystem for UI Components

- **Status**: Accepted
- **Date**: 2026-04-16
- **Deciders**: Magino (founder/architect) + Claude agents (architecture review)

### Context

Givernance's frontend (Next.js 16, React 19, Tailwind CSS v4) must render 84+ screens across 17 domain modules — from dense financial data tables and multi-step grant wizards to inline AI suggestion cards. The existing design system is mature: 366-line `tokens.css` (CSS custom properties for colors, typography, spacing, shadows, motion), 2,000+ line `base.css` component styles, and 97 interactive HTML mockups defining the Material You Warm visual language.

Key constraints driving this decision:

1. **White-label readiness**: Every color must resolve through CSS custom properties in `@theme` — no default Tailwind palette colors permitted anywhere in the codebase
2. **WCAG 2.1 AA accessibility**: Non-negotiable for NPO staff who are not power users — keyboard navigation, screen reader support, focus management, and ARIA compliance on every interactive element
3. **Colorblind-safe semantics**: Indigo for destructive/error states (not red/green pairs); color is never the sole signal — always paired with icon + text label
4. **Density modes**: All data-heavy components must support `comfortable` (48px rows) and `compact` (36px rows) density
5. **Financial data integrity**: Pagination required on all financial tables — infinite scroll explicitly prohibited (see `11-design-identity.md` section 7 anti-patterns)
6. **TypeBox schema reuse**: Form validation schemas defined once in `@givernance/shared/validators` must flow through to frontend form validation without duplication

### Decision

Adopt a **four-library frontend component stack** (note: TanStack Query v5 for server data caching is decided in ADR-011 as part of state management, not repeated here):

1. **shadcn/ui** — UI primitive layer (code-ownership model)
2. **@tanstack/react-table v8** — headless data table engine
3. **React Hook Form + @hookform/resolvers/typebox** — form state management with shared schema validation
4. **lucide-react** — icon library

#### 1. shadcn/ui (UI Primitives)

Copy shadcn/ui components into the repository (`components/ui/`) and own every line. Components are built on **Radix UI** accessibility primitives and restyled to match Givernance's Material You Warm design tokens exactly.

**Component hierarchy**:

```
components/
├── ui/                  ← shadcn/ui primitives (Button, Dialog, Select, Tabs, Tooltip, etc.)
├── data/                ← Data composites (DataTable, StatWidget, DonorTimeline, etc.)
├── forms/               ← Form composites (FormSection, ConstituentForm, DonationWizard, etc.)
└── layout/              ← Layout composites (Sidebar, Topbar, CommandPalette, PageShell, etc.)
```

- **Tier 1 — UI Primitives** (`components/ui/`): Direct shadcn/ui components restyled with Givernance tokens. These are generic, reusable, and have no domain knowledge.
- **Tier 2 — Composites** (`components/data/`, `forms/`, `layout/`): Domain-specific components that compose Tier 1 primitives. Examples: `ConstituentCard` composes `Card` + `Avatar` + `Badge`; `CampaignProgress` composes `Progress` + `StatWidget`.

**Token integration**: shadcn/ui's default CSS variables are replaced entirely with Givernance's `tokens.css` custom properties. The `components.json` configuration points Tailwind to the project's custom theme — no `slate`, `zinc`, or `neutral` from the default palette.

#### 2. @tanstack/react-table v8 (Data Tables)

Headless table engine providing sort, filter, pagination, row selection, and column visibility — with zero rendering opinions. The visual layer is implemented using Givernance's `DataTable` composite component, which applies:

- Sticky headers with `backdrop-filter: blur(12px)` glass effect
- Zebra striping using `--color-neutral-50` alternation
- Density toggle (`comfortable` / `compact` via `--table-row-height` token)
- Server-side pagination with configurable page sizes (25 / 50 / 100)
- Monospace font (`--font-mono`, JetBrains Mono) for financial columns
- Sort indicators with Lucide `arrow-up` / `arrow-down` icons

**Pagination is mandatory on all financial data tables.** Infinite scroll is explicitly prohibited — auditability requires deterministic page boundaries (see `11-design-identity.md` section 7 anti-patterns).

#### 3. React Hook Form + @hookform/resolvers/typebox (Forms)

Form state management using React Hook Form with TypeBox schema validation, enabling a **single source of truth** for data contracts:

```
@givernance/shared/validators/donation.ts (TypeBox schema)
  → API route: Fastify request validation + OpenAPI 3.1 generation
  → Frontend form: React Hook Form validation via @hookform/resolvers/typebox
```

Configuration:
- Validation mode: `onBlur` — validates each field when the user leaves it, never on keystroke (reduces noise) and never only on submit (too late)
- Server error mapping: RFC 9457 `fieldErrors` from API responses are mapped to form fields via `setError()`, providing inline server-side validation feedback
- Multi-step forms (grant wizard, constituent create): each step validates its own TypeBox sub-schema independently before allowing progression

#### 4. lucide-react (Icons)

Tree-shakeable icon library providing named SVG imports. Only icons actually used are included in the bundle — no variable font download.

- Grid: 24px
- Stroke weight: 1.5px (matches design spec in `11-design-identity.md` section 2.4)
- Native shadcn/ui integration (icons used directly in Button, Alert, Badge, etc.)
- Consistent with the 97 existing HTML mockups which already use Lucide CDN

### Rationale

#### Why shadcn/ui over alternatives

| Criterion | shadcn/ui + Radix | Headless UI (Tailwind Labs) | Ant Design | Material UI | Build from scratch |
|---|---|---|---|---|---|
| **Code ownership** | Full — components copied into repo, every line editable | Full — headless primitives | None — import from `antd`, override via `ConfigProvider` | None — import from `@mui`, override via `createTheme` | Full |
| **Accessibility** | Radix UI primitives — WAI-ARIA compliant, focus trap, keyboard nav, screen reader tested | Good — built by Tailwind Labs | Mixed — some components lack ARIA compliance | Good — follows Material spec | Must build from scratch |
| **Tailwind v4 compatibility** | Native — designed for Tailwind | Native | Poor — CSS-in-JS (Emotion) conflicts with Tailwind utility model | Poor — Emotion/styled-components, theme provider conflicts | N/A |
| **White-label theming** | CSS custom properties — drop-in token replacement | CSS custom properties | `ConfigProvider` + `antd-style` — complex, leaks default styles | `createTheme` — deep but opinionated | Full control |
| **Bundle size** | Tree-shakeable, only imported components included | Minimal | ~1.2 MB minified (full import), heavy even with tree-shaking | ~300 KB+ for core, Emotion runtime overhead | Minimal |
| **Design language** | Neutral — adapts to any design system | Neutral | Opinionated Ant style — fighting it is constant work | Opinionated Material — requires heavy override for non-Material designs | Any |
| **React 19 / RSC support** | Yes — `"use client"` only where needed | Yes | Partial — many components require client-side rendering | Partial — Emotion SSR complexity | Must implement |
| **Community + ecosystem** | 75k+ GitHub stars, 100+ components, active maintenance | Smaller component set (~15 primitives) | Massive (Chinese enterprise ecosystem) | Massive (Google-backed) | None |
| **Verdict** | **Selected** | Good primitives but fewer components; would need to build more composites | Rejected — CSS-in-JS conflicts, opinionated style, heavy bundle | Rejected — CSS-in-JS conflicts, Material design language fights Givernance identity | Rejected — 6+ months to reach shadcn/ui parity on accessibility alone |

#### Why @tanstack/react-table over alternatives

| Criterion | @tanstack/react-table v8 | AG Grid | Mantine DataTable |
|---|---|---|---|
| **Rendering model** | Headless — full visual control | Opinionated grid with theme API | Mantine-styled — tied to Mantine theme |
| **Givernance token integration** | Direct — render layer uses Tailwind + design tokens | Theme override required, AG Grid CSS fights custom styles | Requires Mantine `MantineProvider`, separate from Tailwind |
| **Server-side pagination** | Native — `manualPagination`, `pageCount`, `onPaginationChange` | Native | Native |
| **Bundle size** | ~15 KB (headless core) | ~200 KB+ (community), ~1 MB+ (enterprise) | ~50 KB + Mantine core dependency |
| **License** | MIT | Community: MIT, Enterprise: paid (features like row grouping, pivoting) | MIT |
| **Financial table fit** | Excellent — monospace columns, custom cell renderers, controlled pagination | Excellent — but visual override cost is high | Good — but Mantine style dependency |
| **Verdict** | **Selected** | Rejected — too heavy, visual lock-in, enterprise features not needed at Phase 1 | Rejected — introduces Mantine as a parallel design system |

#### Why React Hook Form + TypeBox over alternatives

| Criterion | React Hook Form + TypeBox | Formik | Native React forms |
|---|---|---|---|
| **Performance** | Uncontrolled inputs — minimal re-renders | Controlled inputs — re-renders entire form on every change | Depends on implementation |
| **Schema reuse** | `@hookform/resolvers/typebox` — validates with the same TypeBox schemas used by Fastify routes | Yup/Zod schemas — separate from TypeBox API schemas, duplication risk | Manual validation — full duplication |
| **Bundle size** | ~9 KB (RHF) + ~2 KB (resolver) | ~13 KB | 0 KB |
| **Server error integration** | `setError()` API maps RFC 9457 `fieldErrors` directly to fields | `setFieldError()` — similar capability | Manual state management |
| **Multi-step forms** | Built-in — each step is a separate `useForm()` or sub-schema validation | Possible but verbose | Manual orchestration |
| **TypeScript DX** | Excellent — form values inferred from TypeBox schema type | Good with Yup, weaker with plain objects | Manual typing |
| **Verdict** | **Selected** | Rejected — heavier, controlled re-renders, separate schema system | Rejected — no schema reuse, no built-in validation lifecycle |

#### Why lucide-react over alternatives

| Criterion | lucide-react | Material Symbols | Heroicons | Phosphor Icons |
|---|---|---|---|---|
| **Bundle strategy** | Named imports — tree-shakeable, only used icons in bundle | Variable font — ~300 KB download regardless of usage | Named imports — tree-shakeable | Named imports — tree-shakeable |
| **Icon count** | 1,500+ | 3,000+ | ~300 | 1,200+ |
| **Grid / stroke** | 24px / 1.5px — matches design spec | 24px / variable weight — configurable but heavier | 24px / 1.5px or 2px | 24px / variable weight |
| **shadcn/ui integration** | Native — shadcn/ui uses Lucide by default | None — must configure separately | Partial — some shadcn forks use Heroicons | None — must configure separately |
| **Consistency with mockups** | Direct match — 97 HTML mockups already use Lucide CDN | Would require icon remapping across all mockups | Different icon set — visual inconsistency | Different icon set — visual inconsistency |
| **Verdict** | **Selected** | Rejected — 300 KB font download, no tree-shaking, mockup inconsistency | Rejected — too small a set (300 icons), partial shadcn compatibility | Rejected — good alternative but no native shadcn integration, mockup inconsistency |

### Consequences

- ✅ **Code ownership**: Every UI component lives in the repository — no upstream dependency can break the design or introduce breaking changes
- ✅ **Single validation source of truth**: TypeBox schemas in `@givernance/shared/validators` are used by Fastify routes (API validation + OpenAPI generation) and React Hook Form (frontend validation) — zero schema duplication
- ✅ **Full visual control**: Headless primitives (Radix UI, TanStack Table) render through Givernance's token system — white-label theming requires only `tokens.css` override, no library-specific theme configuration
- ✅ **Accessibility baseline**: Radix UI provides WAI-ARIA compliant focus management, keyboard navigation, and screen reader support out of the box — the team builds on top of tested primitives rather than implementing ARIA from scratch
- ✅ **Mockup continuity**: The 97 existing HTML mockups already use Lucide icons and the same visual patterns — migration to React components is a 1:1 translation, not a redesign
- ✅ **Bundle efficiency**: Tree-shakeable icons (Lucide) + headless table (~15 KB) + uncontrolled forms (RHF ~9 KB) — no large framework runtime overhead
- ⚠️ **shadcn/ui update friction**: Because components are copied (not imported), upstream improvements require manual cherry-picking — the team must periodically review shadcn/ui releases for accessibility fixes and new primitives
- ⚠️ **Radix UI version coupling**: shadcn/ui components depend on specific Radix UI primitive versions — major Radix updates may require coordinated component updates
- ⚠️ **TypeBox resolver maturity**: `@hookform/resolvers/typebox` is less widely used than the Zod resolver — edge cases in complex nested schemas may require custom resolver patches
- ⚠️ **Component build-out effort**: shadcn/ui provides ~40 primitives; Givernance needs ~25 domain composites (DataTable, ConstituentCard, DonorTimeline, CampaignProgress, etc.) — these must be designed and built by the team
- ⚠️ **AI suggestion card XSS risk**: AI-generated content rendered in suggestion cards must never use `dangerouslySetInnerHTML`. All AI output must be rendered as plain text or through a sanitization layer (e.g., DOMPurify) to prevent stored XSS from model outputs. See `13-ai-modes.md` for AI output policy.
- ⚠️ **CSP compatibility**: Radix UI primitives use inline styles for positioning (popovers, tooltips, dropdown menus). A Content Security Policy with `style-src 'unsafe-inline'` may be required, or a nonce-based CSP strategy must be adopted. Evaluate CSP impact during Phase 1 deployment.
- ⚠️ **Dependency scanning**: shadcn/ui components are copied into the repository but still depend on Radix UI npm packages as runtime dependencies. These must be included in the SBOM and scanned for CVEs in CI, consistent with `06-security-compliance.md` requirements.

### Revisit Criteria

- shadcn/ui abandons Radix UI as its accessibility foundation — re-evaluate primitive layer
- React 20+ introduces built-in form primitives that obsolete React Hook Form
- A headless component library emerges with significantly better RSC support or accessibility coverage
- TanStack Table v9 introduces breaking API changes — evaluate migration cost vs alternatives
- Bundle size analysis at Phase 2 reveals unexpected bloat from the component stack

---

## ADR-013: Frontend Type Boundary — No Drizzle Imports in Web Package

- **Status**: Accepted
- **Date**: 2026-04-16
- **Deciders**: Magino (founder/architect)

### Context

Givernance is a full-stack TypeScript monorepo (ADR-002) where `@givernance/shared` exports five subpath modules:

| Subpath | Contents | Runtime dependency |
|---|---|---|
| `@givernance/shared/schema` | Drizzle ORM table definitions (`pgTable`, columns, relations) | `drizzle-orm`, `drizzle-orm/pg-core` |
| `@givernance/shared/types` | Pure TypeScript interfaces and enums (`AuthContext`, `Currency`, `ConstituentType`) | None |
| `@givernance/shared/validators` | TypeBox schemas for request/response validation | `@sinclair/typebox` |
| `@givernance/shared/events` | Domain event type definitions (CloudEvents envelope, outbox types) | Type-only (no runtime import), but exposes internal system topology |
| `@givernance/shared/jobs` | Background job payload definitions | Type-only (no runtime import), but exposes worker capabilities and queue structure |

The frontend (`packages/web`, Next.js 16) communicates with the backend exclusively through REST API calls — it never connects to PostgreSQL directly. However, without explicit import restrictions, a developer could import Drizzle schema types into frontend code, creating type-safety illusions and security surface expansion.

Drizzle's `InferSelectModel<typeof constituents>` produces TypeScript types where:
- Date columns are typed as `Date` objects — but JSON serialization returns ISO 8601 strings
- Nullable columns include `null` — but API responses may use default values or omit fields
- `bigint` columns are typed as `bigint` — but `JSON.parse` returns `number`

These mismatches are invisible at compile time but cause runtime errors: `.toISOString()` called on a string, strict equality checks failing between `bigint` and `number`, and `null` propagating through UI components that expected `undefined`.

### Decision

Enforce a strict import boundary: **`packages/web` MUST NOT import from `@givernance/shared/schema`, `@givernance/shared/events`, or `@givernance/shared/jobs`.**

`packages/web` MAY import from:
- `@givernance/shared/types` — pure TypeScript interfaces with no runtime dependencies (enums, auth context, currency codes)
- `@givernance/shared/validators` — TypeBox schemas reused for client-side form validation (same validation rules on API and frontend, single source of truth per ADR-002)

Frontend-specific API response models live in `packages/web/src/models/` as plain TypeScript interfaces where dates are `string` (ISO 8601), matching JSON serialization reality (see ADR-011 Domain Models layer).

### Enforcement

| Mechanism | Layer | Description |
|---|---|---|
| Subpath exports | Package level | `@givernance/shared/package.json` declares explicit `"exports"` — only listed subpaths are resolvable |
| Lint rule | CI/IDE | Biome `noRestrictedImports` rule in `packages/web/biome.json` bans `@givernance/shared/schema`, `@givernance/shared/events`, `@givernance/shared/jobs` with actionable error messages |
| Code review | Process | PR reviews verify no new Drizzle imports in `packages/web/` |
| Source maps | Build config | Production builds (`next.config.ts`) MUST disable source maps (`productionBrowserSourceMaps: false`) to prevent exposing internal architecture via client-side JavaScript |

### Rationale

- **Type/runtime mismatch prevention**: Drizzle `InferSelectModel` types describe database row shapes, not JSON API response shapes. Using them in frontend code creates a false sense of type safety — the types compile but lie about runtime values. Frontend models must reflect what `JSON.parse` actually produces.
- **Server-only dependency containment**: Importing `@givernance/shared/schema` pulls `drizzle-orm` and `drizzle-orm/pg-core` into the Next.js bundle. These are server-only packages with Node.js dependencies (`pg`, `crypto`) that fail in browser environments and inflate bundle size.
- **Least privilege / attack surface reduction**: Domain events expose internal system topology (queue names, retry policies, outbox structure). Job definitions expose worker capabilities and processing semantics. Neither is needed by the frontend — exposing them violates the principle of least privilege and leaks architectural details that could inform targeted attacks.
- **GDPR defense in depth**: The API layer is the GDPR enforcement boundary — it applies RLS tenant isolation (`06-security-compliance.md`, 3-role pattern), RBAC permission checks, PII redaction, and audit logging before returning data. Frontend code that appears to "know" database column structure may encourage developers to bypass the API contract or assume field-level access that RBAC actually restricts. Maintaining a clean API boundary reinforces the single enforcement point for data protection.
- **Module boundary discipline**: Consistent with ADR-001 (modular monolith) — boundaries between modules are enforced via linting rules, not just convention. The frontend/backend boundary is the most critical module boundary in the system.

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Import Drizzle types directly (`InferSelectModel`) | Zero duplication, single type source | `Date` vs `string` mismatch causes runtime bugs; pulls `drizzle-orm` into browser bundle; false type safety | Rejected |
| Single barrel export from `@givernance/shared` | Simple imports (`from '@givernance/shared'`) | No boundary enforcement; any consumer gets everything; impossible to lint restricted imports | Rejected |
| Generate OpenAPI types from Fastify schemas | True contract-first; auto-generated frontend types | Requires `openapi-typescript` toolchain + CI codegen step; heavy for current team size (1-2 engineers); revisit at Phase 3 | Rejected — revisit at Phase 3 |
| Use Zod instead of TypeBox for shareable schemas | Zod is popular, good DX | Rejected per ADR-002 implementation note; TypeBox provides native Fastify integration and OpenAPI 3.1 compatibility without conversion | Rejected |
| **Subpath restriction + lint enforcement + frontend models** | Clean boundary, enforced at multiple layers, frontend types match JSON reality | Small duplication between DB types and API response types | **Selected** |

### Consequences

- ✅ **Runtime correctness**: Frontend types match actual JSON wire format — dates are `string`, numbers are `number`, no `bigint` surprises
- ✅ **Bundle safety**: `drizzle-orm` and `drizzle-orm/pg-core` never enter the Next.js client bundle — no Node.js polyfill failures, smaller bundle
- ✅ **GDPR enforcement boundary preserved**: The REST API remains the single point of GDPR control — RLS tenant isolation via `withTenantContext()`, RBAC permission matrix (`06-security-compliance.md`), PII redaction (Pino `redact` + RFC 9457 strict response schemas), and immutable audit logging. Frontend developers cannot accidentally circumvent data protection by importing database-level types that suggest direct field access
- ✅ **Security posture**: Internal system architecture (event topology, job queue structure, outbox design) is not exposed to frontend code — reduces information available to an attacker who gains access to client-side source maps or bundled JavaScript
- ✅ **Lint-enforced in CI**: Violations are caught by Biome before merge — not dependent on code review alone
- ✅ **Consistent with ADR-011**: The Domain Models layer in `packages/web/src/models/` is the designated home for frontend-specific API response types, reinforcing the layered service architecture
- ⚠️ **Type duplication**: API response interfaces in `packages/web/src/models/` partially duplicate fields from Drizzle schema types. This is intentional — the duplication reflects a real semantic difference (DB row shape vs. JSON response shape) and prevents a class of runtime bugs
- ⚠️ **Developer onboarding**: New developers must understand why `import { constituents } from '@givernance/shared/schema'` is banned in `packages/web/`. Lint error messages must include actionable guidance (e.g., "Import from `@/models/constituent` for API response types — see ADR-013")
- ⚠️ **OpenAPI codegen re-evaluation at Phase 3**: When the team grows beyond 2 engineers, auto-generating frontend types from Fastify route schemas (via `openapi-typescript`) should be re-evaluated to eliminate manual model maintenance while preserving the type boundary

---

## ADR-015: Internationalization & Translation Strategy

- **Status**: Accepted
- **Date**: 2026-04-17
- **Deciders**: Magino (founder/architect) + Claude agents (architecture review)

### Context

Givernance targets European NPOs across FR, BE, NL, DE, and CH markets. The five user personas speak French (all), English (3/5), German (1/5), and Arabic (1/5 — conversational). The organization settings screen (ADM-001) includes a locale selector. Yet after Sprint 4 frontend implementation, ~110 user-facing strings are hardcoded across 15 files — a mix of French (app shell, dashboard) and English (auth pages, error pages). Without a formal i18n strategy, hardcoded strings will compound as Sprint 5+ builds 84+ screens.

### Decision

#### Library: next-intl (non-prefixed routing)

Adopt **next-intl** for frontend i18n with **cookie-based locale detection** (no URL prefix routing). A CRM is not a public SEO-dependent site — locale-prefixed URLs (`/fr/dashboard`, `/en/dashboard`) add complexity without benefit. The locale is determined by:

1. `NEXT_LOCALE` cookie (set via org settings or user preference)
2. `Accept-Language` header fallback
3. Default: `fr` (primary market)

#### Supported Locales

| Phase | Locales | Rationale |
|-------|---------|-----------|
| Phase 2 (now) | `fr`, `en` | Primary markets (FR, BE francophone, UK/international NPOs) |
| Phase 3 | + `de`, `nl` | DE/CH/NL expansion |
| Phase 4+ | + `ar` (RTL) | Persona Karim — requires RTL CSS preparation |

Default locale: **`fr`** — all mockups are in French, primary market is French NPOs.

#### Key Structure: Module Namespaces

Translation keys use **dot-separated module namespaces** in a single file per locale:

```
messages/
├── fr.json    ← { "common": {...}, "auth": {...}, "appShell": {...}, "dashboard": {...} }
└── en.json
```

Naming convention: `{module}.{component}.{element}` — e.g., `auth.login.title`, `appShell.sidebar.dashboard`, `common.actions.cancel`.

Single file per locale (not split per module) because:
- The CRM has ~110 keys today, projected ~500 at full build — well within a single file
- Simplifies CI key-parity check and avoids import complexity
- next-intl loads only the requested namespace at runtime regardless of file structure

#### Frontend i18n Pattern

**Server Components** (pages, layouts):
```typescript
import { getTranslations } from "next-intl/server";
const t = await getTranslations("dashboard");
// t("greeting", { name: auth.firstName })
```

**Client Components** (interactive UI):
```typescript
import { useTranslations } from "next-intl";
const t = useTranslations("appShell");
// t("sidebar.dashboard")
```

**Configuration**: `src/i18n/request.ts` provides the locale and messages to next-intl's server context. The root layout wraps children in `<NextIntlClientProvider>` for client component access.

#### Backend i18n

| Concern | Approach |
|---------|----------|
| API error messages (RFC 9457 `detail`) | Accept `Accept-Language` header; Fastify plugin resolves locale; error `detail` field translated via `i18next` with JSON message files in `packages/api/messages/` |
| Email templates (BullMQ) | Deferred to Phase 3 — no email templates exist yet. BullMQ job payload will carry `locale` field; worker resolves templates per locale |
| PDF generation (fiscal receipts) | Deferred to Phase 3 — PDF engine will accept locale parameter for number/date formatting and legal text |

#### Database Content

Translatable fields (e.g., campaign public page title, custom form labels) use a **JSON column** pattern:

```sql
title_i18n JSONB NOT NULL DEFAULT '{}' -- {"fr": "Appel aux dons", "en": "Fundraising appeal"}
```

With a helper: `getLocalized(row.title_i18n, locale, 'fr')` — falls back to French if translation missing. This avoids a separate translation table while keeping the schema simple for Phase 2.

#### Pluralization & Formatting

- **Plurals**: ICU MessageFormat via next-intl — `{count, plural, one {# don} other {# dons}}`
- **Currency**: `Intl.NumberFormat` with locale + currency from org settings (EUR/CHF)
- **Dates**: `Intl.DateTimeFormat` with locale from org settings
- **Centralized**: Formatting utilities in `src/lib/format.ts` wrapping `Intl` APIs, driven by org locale

#### RTL Preparation

Phase 4+ (Arabic). Architecture must not block it:
- CSS logical properties (`margin-inline-start` not `margin-left`) — enforced via Biome lint rule when Arabic is added
- `dir="rtl"` attribute on `<html>` driven by locale
- Tailwind v4 RTL utilities (`rtl:` variant) available when needed
- No hardcoded `left`/`right` positioning in layout components (use `start`/`end`)

#### Type Safety

next-intl's TypeScript integration with a global type declaration:

```typescript
// src/types/next-intl.d.ts
import type messages from "../../messages/fr.json";
type Messages = typeof messages;
declare module "next-intl" {
  interface AppConfig { Messages: Messages; }
}
```

This provides compile-time checks that all translation keys exist. Missing keys cause TypeScript errors.

#### Translation Workflow

1. Developer writes French strings first (source language)
2. Developer provides English translation in the same PR
3. Translation Specialist agent reviews both languages during PR review
4. Future: Tolgee (self-hostable, GDPR-friendly) for professional translator access — evaluated but not procured in Phase 2

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **react-intl (FormatJS)** | Mature, ICU MessageFormat, good DX | No native App Router/RSC support; requires wrapping every Server Component; heavier bundle than next-intl | Rejected |
| **i18next + react-i18next** | Massive ecosystem, namespace support, backend support | Complex setup for Next.js App Router; `next-i18next` wrapper abandoned; no native RSC integration | Rejected |
| **next-intl** | Native App Router/RSC support, ICU MessageFormat, TypeScript type safety, lightweight, active maintenance | Smaller ecosystem than i18next | **Selected** |
| **URL-prefix routing** (`/fr/dashboard`) | SEO-friendly, locale in URL | CRM is auth-gated (no SEO need), doubles route complexity, breaks existing route structure | Rejected for CRM (appropriate for marketing site) |
| **Per-module JSON files** | Clean separation | Overhead for ~500 keys; complicates CI check; next-intl namespace loading handles this already | Rejected |

### Consequences

- ✅ All user-facing strings are translatable — no hardcoded text in JSX
- ✅ Type-safe keys prevent typos and missing translations at compile time
- ✅ French-first approach matches mockup language and primary market
- ✅ Cookie-based locale keeps CRM URLs clean (no /fr/ /en/ prefixes)
- ✅ Same library (next-intl) can be used if a marketing site is added later
- ⚠️ Single JSON file per locale will need splitting if key count exceeds ~1000 (Phase 4+)
- ⚠️ Backend i18n (i18next for Fastify) is a separate library from frontend (next-intl) — term glossary ensures consistency
- ⚠️ Arabic RTL support requires CSS audit before Phase 4 — logical properties must be enforced retroactively

---

## ADR-016: Tenant Onboarding & Multi-Tenancy — Hybrid Self-Serve + Enterprise Model

- **Status**: Proposed
- **Date**: 2026-04-23
- **Deciders**: Magino (founder/architect), team design session 2026-04-23
- **Related**: `docs/21-authentication-sso.md`, `docs/22-tenant-onboarding.md`, Spike [#80](https://github.com/purposestack/givernance/issues/80), ADR-009 (data residency), ADR-011 (layered frontend), ADR-013 (type boundary)

### Context

Phase 1 shipped a super-admin-only tenant provisioning path (`POST /v1/tenants` guarded by `requireAdminSecret`) and a Keycloak OIDC login flow (`docs/21-authentication-sso.md`). Spike #80 chose a shared Keycloak realm with groups + attributes (Option A) and concluded that a Givernance platform operator would provision every tenant from the back-office. That design is correct for the enterprise segment but does **not** cover the long tail of tiny European NPOs that Givernance targets:

- Most French associations under 20 staff have **no corporate email domain** — they run on gmail / outlook / proton personal inboxes (`greg-field-insights` §3, team design session 2026-04-23).
- Super-admin-only provisioning does not scale from 5 pilots to hundreds of tenants, and it is a conversion-killer for a self-serve SMB segment.
- The earlier (now-deprecated) "5-step onboarding wizard" from issue #33 predates the SSO-only decision and cannot be resurrected as-is.

The team design session (2026-04-23) reopened these questions and concluded that **both paths must coexist**: enterprise tenants whose admin is provisioned by a platform operator, and SMB tenants who self-serve from a public signup form using personal email.

### Decision

Givernance adopts a **hybrid tenant onboarding model** with three tenant tracks, all living in the same shared Keycloak realm and same PostgreSQL cluster:

| Track | Who creates the tenant | First-admin identity | IdP federation | Example |
|---|---|---|---|---|
| **Self-serve (SMB)** | Public signup form; first user becomes *provisional* `org_admin` | Personal email, OTP-verified via Keycloak | None — Keycloak local authenticator (password / magic link) | Tiny French NPO using `tresorier@gmail.com` |
| **Enterprise SSO** | Givernance super-admin from the back-office | Domain-verified corporate email, JIT-provisioned from IdP claims | Per-tenant OIDC / SAML IdP (Entra, Okta, Google Workspace) wired to the shared realm | Red Cross France, Médecins du Monde |
| **Invitation-join** | Another tenant's `org_admin` invites the user by email | The invited email (personal or corporate) | Inherits the target tenant's IdP (if any) | Volunteer board member joining an existing NPO |

All three tracks produce the same domain model: a `tenants` row, an optional `tenant_domains` row set (enterprise only), and `users` rows created **Just-In-Time** on first SSO login via trusted Keycloak JWT claims (`sub`, `email`, `org_id`, `role`). RLS isolation on `org_id` remains the sole tenancy boundary at the database layer.

**Platform primitives adopted**:

1. **Keycloak Organizations** (Keycloak 26+) replaces the ad-hoc groups-and-attributes approach from Spike #80. Organizations is GA as of Keycloak 26.0 and provides first-class org entities with domain-based IdP routing, per-org IdP bindings, and invitation flows.
2. **URL-path tenant scoping** (`app.givernance.app/<org-slug>/…`) — **not** subdomain scoping. One wildcard TLS cert, no DNS propagation delay at tenant creation, no cross-subdomain cookie leakage. Subdomain routing is reserved for a future Enterprise tier where perception matters (Cloudflare for SaaS).
3. **Provisional `org_admin` with grace period** — on self-serve, the first user is `org_admin` for 7 days; other verified users from the same domain can dispute within that window. Destructive actions (delete-org, export-all) are gated behind verification.
4. **No credit card at signup** — 30-day trial, then card *or* annual invoice at conversion. This matches the NPO segment's procurement realities.
5. **Disposable-email + IP/ASN rate limits** as first-order abuse filters. Payment is **not** used as a signup filter; it is reserved for conversion.
6. **Post-login organization picker** — a single user can belong to multiple tenants; `org_id` is minted into the access token at picker time and re-minted on switch. Refresh token is user-scoped.

### Rationale

- **Two-track design reflects customer reality.** Treating the long-tail SMB as an afterthought on top of an enterprise-first design yields worst-of-both-worlds UX. Treating enterprise as an afterthought on top of SMB fails audits. Two tracks with shared infrastructure is the 2026 consensus (WorkOS Organizations, Clerk Organizations, Stytch B2B).
- **Keycloak Organizations over custom group/attribute plumbing.** The groups-and-attributes approach chosen in Spike #80 predates Keycloak 26. For a product starting to add tenants in 2026, Organizations is the right primitive: fewer custom mappers, native Home IdP Discovery, built-in invitation templates, actively developed.
- **URL-path over subdomain** avoids wildcard-TLS provisioning, cross-subdomain cookie pitfalls, and per-tenant DNS operations — and it unlocks *instant* tenant creation, which the self-serve flow requires.
- **Provisional admin with grace period** prevents the "random intern becomes org_admin" failure mode without blocking legitimate self-serve signup.
- **RLS unchanged** — this ADR adds primitives around identity but leaves the data-layer tenancy model (single shared database, `org_id`-scoped RLS, 3-role Postgres pattern) exactly as decided in ADR-009.
- **Card-at-conversion, not signup** — nonprofit budgets are annual and board-approved; card-at-signup is a conversion killer for this segment (ProfitWell / Baymard SMB benchmarks). Reserve card-at-signup for a future high-abuse scenario.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Super-admin-only provisioning (Spike #80 as-is) | Strong control; simple model | Does not scale; kills SMB conversion; blocks self-serve pilots | Rejected — retained as the enterprise track only |
| First-user-becomes-admin with no safeguards (2026-04-23 naive variant) | Dead simple | Random employee can lock out real admins; no path to revoke | Rejected — replaced by provisional-admin-with-grace-period |
| Paywall at signup as anti-abuse filter | Eliminates bots; validates intent | Conversion-killer for SMB NPOs; EU dark-pattern regulations (DGCCRF / ACM enforcement) | Rejected — moved to conversion event |
| Subdomain-per-tenant (`<ngo>.givernance.app`) from day one | Enterprise perception; strong isolation | Wildcard TLS operations, cross-subdomain cookie issues, delayed provisioning | Rejected for MVP — reserved for future Enterprise tier with Cloudflare for SaaS |
| One Keycloak realm per tenant | Hard IdP isolation; per-realm branding | Thousands of realms = operational explosion; tested by Spike #80 and rejected | Rejected — retained only as the self-hosted "dedicated realm" escape hatch |
| Keycloak groups + attributes (Spike #80 Option A) | Works today; no Keycloak 26 upgrade needed | Requires custom domain routing, custom mappers, manual invitation plumbing; Organizations supersedes it | Rejected for net-new work — existing groups/attributes in the dev seed will be migrated |
| Email domain as sole tenant-binding authority | Zero UX friction | Personal-email orgs locked out; someone at `intern@ngo.fr` cannot bind BigCorp; no DNS proof | Rejected — domain is one signal of many, with DNS TXT as the hard gate for enterprise |

### Consequences

- **Keycloak upgrade required** — infra target becomes Keycloak 26.x. Issue #61 (split Keycloak DB) becomes a prerequisite; migrating the dev realm seed from groups/attributes to Organizations is scheduled in this milestone.
- **Schema additions** — `tenants` gets `status` ∈ `provisional | active | suspended | archived`, `verified_at`, `created_via` ∈ `self_serve | enterprise | invitation`; new tables `tenant_domains` (domain + DNS TXT verification state), `tenant_admin_disputes` (grace-period dispute log). Existing Phase 1 `tenants` schema is kept backward-compatible.
- **API additions** — `POST /v1/public/signup`, `POST /v1/public/email-verify`, `POST /v1/admin/tenants/:id/provision-idp`, `GET /v1/users/me/organizations`, `POST /v1/session/switch-org`, `POST /v1/tenants/:id/domains`, `POST /v1/tenants/:id/domains/:domain/verify`. All enterprise-admin endpoints on the existing `packages/api/src/modules/admin/` / `…/tenants/` boundaries; self-serve endpoints live under a new `public` module that skips tenant context until the target org is resolved.
- **Frontend additions** — public signup/verify pages, organization picker screen, back-office admin screens for tenants+domains+IdP config, provisional-admin banner in the app shell (reusing the impersonation banner pattern from PR #73).
- **Docs 21 update** — `docs/21-authentication-sso.md` is refactored to reference this ADR + `docs/22-tenant-onboarding.md` instead of embedding the obsolete super-admin-only flow.
- **Issue #80 remains open** as an architectural context doc; implementation issues under the new milestone "Tenant Onboarding & Multi-Tenancy" replace it.
- **Issue #78** (onboarding wizard Steps 2–4) is rebaselined on the hybrid flow; Step 1 becomes the public signup form, Step 5 becomes the provisional-admin welcome.
- **Issue #33** (old 5-step wizard) is closed as superseded.
- **Abuse surface** — new public endpoints require rate limiting (Fastify `@fastify/rate-limit`, Redis store), disposable-email blocklist, CAPTCHA (hCaptcha) on signup, and an audit trail of every signup attempt (`audit_logs.action = 'tenant.signup_attempted'`).
- **GDPR posture** — signup form collects minimal PII (email + display name); country/legal-type asked in-product after signup; DPO email collected at verification step, aligning with Phase 2 GDPR consent work in #78.

### Revisit criteria

- If self-serve abuse (fake tenants, spam sends) exceeds a threshold (e.g., > 5% of new tenants flagged in 30 days), evaluate moving to "payment card at signup" for self-serve track only.
- If multi-domain orgs (one NPO with `ngo.fr` and `ngo.org` both valid) are not well-served by Keycloak Organizations (edge cases in domain verification or Home IdP Discovery), revisit the Organizations adoption.
- If subdomain-per-tenant demand from enterprise tenants emerges before the Cloudflare-for-SaaS investment is justified, we either ship a coarser DNS-per-tenant flow or keep URL-path scoping and defer.

---

*This document is curated to show only active architectural decisions. Superseded decisions are removed for clarity.*