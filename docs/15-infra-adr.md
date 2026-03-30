# 15 — Architecture Decision Records

This document captures key architectural decisions for Givernance, recording context, rationale, and tradeoffs for future reference.

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
- **Shared types** between frontend (Next.js) and backend (Fastify) via `packages/shared` — a single Zod schema defines API contract, request validation, and form validation
- **TypeScript type safety + Zod runtime validation** covers Go's compile-time safety advantage with the added benefit of runtime enforcement
- **Fastify 5 benchmarks at ~77,000 req/s** on Node.js 22 — well above the target NPO workload of ~500 req/s at peak (200-staff org, 50 concurrent users)
- **BullMQ** (TypeScript-native) is a direct functional equivalent to Asynq (Go) — both Redis-backed, both support cron, retries, and concurrency control
- **Drizzle ORM** provides Go-like type safety for SQL queries in TypeScript, with explicit SQL semantics (no magic)
- **Ecosystem advantage**: TypeScript has a significantly larger developer pool than Go; easier hiring for a European NPO-focused startup
- **Immediate benefit**: Zod schemas reused from API validation in Next.js forms create a single source of truth for data contracts

### Tradeoffs

| Option | Pros | Cons | Verdict |
|---|---|---|---|
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

- Schema definitions live in `packages/db/schema/` as TypeScript files — these are the source of truth for both migrations and application types
- Migration workflow: modify schema → `drizzle-kit generate` → review SQL → `drizzle-kit migrate`
- RLS enforcement pattern: Fastify request hook calls `SET LOCAL app.tenant_id = $1` at transaction start — must be tested in Phase 1 integration tests
- Team members must learn Drizzle's API (smaller community means fewer Stack Overflow answers, but official docs are comprehensive)

---

## ADR-004: BullMQ over Other Job Queues

- **Status**: Accepted
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

Givernance requires a reliable background job system for: email dispatch, PDF/report generation, Salesforce migration ETL, GDPR data export/deletion, scheduled donation reminders, and AI processing pipelines. The system must support cron scheduling, retry with backoff, concurrency control, and job prioritization. Redis is already in the stack for caching and rate limiting.

### Decision

Use **BullMQ 5** as the background job queue, backed by the existing Redis instance.

### Rationale

- **TypeScript-native**: First-class TypeScript support with generics for type-safe job data (`Queue<DonationReceiptJob>`)
- **Redis-backed**: Reuses the same Redis instance already required for caching, rate limiting, and session storage — no additional infrastructure
- **Feature-rich**: Supports repeatable jobs (cron), delayed jobs, job prioritization, rate limiting per queue, sandboxed processors (separate Node.js processes), and flow/parent-child job dependencies
- **Battle-tested**: Used in production by companies processing millions of jobs/day; mature ecosystem with BullBoard for monitoring
- **Direct replacement for Asynq**: Functional parity with the Go-based Asynq library originally planned — both are Redis-backed with similar APIs for enqueue, process, retry, and cron

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Asynq (Go)** | Lightweight, Go-native | Requires Go runtime, cannot share types with TypeScript stack | Rejected (Go stack abandoned) |
| **Agenda (Node.js)** | MongoDB-backed, simple API | MongoDB dependency (not in stack), less active maintenance | Rejected |
| **pg-boss** | PostgreSQL-backed (no Redis needed) | Lower throughput than Redis-backed solutions, less feature-rich than BullMQ | Considered — revisit if Redis is removed from stack |
| **BullMQ 5** | TypeScript-native, Redis-backed, full-featured, active maintenance | Redis dependency (already in stack), memory usage for large job payloads | **Selected** |

### Consequences

- Redis becomes a critical infrastructure component (was optional for caching, now required for job queue) — must be included in HA planning from Phase 2
- Job definitions live in `apps/api/src/jobs/` with shared job data types in `packages/shared`
- BullBoard dashboard integrated into the admin panel for job monitoring (Phase 1)
- Large job payloads (e.g., Salesforce migration batches) should store data in PostgreSQL and pass only IDs through Redis to avoid memory pressure

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
DB transaction (mutation + domain_events row)
  → Outbox poller (500ms)
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
- ⚠️ No event replay in Phase 0-3 — if needed, query `domain_events` table directly
- ⚠️ Multi-subscriber fan-out not available until Phase 4 — enforce single-consumer contract in outbox design
- Module event contracts should still be defined as TypeScript interfaces (in `packages/shared/events/`) to ease future NATS integration
- BullMQ becomes the sole async backbone — its Redis dependency must be treated as critical infrastructure

---

## ADR-006: Managed SaaS Infrastructure — Neon.tech + Upstash + Cloudflare R2

**Status:** Superseded by ADR-009
**Date:** 2026-03-09

### Context

The initial architecture assumed fully self-hosted PostgreSQL + PgBouncer + Redis + MinIO for all deployment scenarios. For the **SaaS managed offering**, this creates unnecessary operational burden for a small founding team: database backups, failover configuration, Redis cluster management, and S3-compatible storage administration.

### Decision

For the **SaaS managed deployment**, use managed cloud services:

| Component | Managed Service | Rationale |
|---|---|---|
| PostgreSQL | [Neon.tech](https://neon.tech) EU region | Managed Postgres, built-in pooling, branching, WAL backup, EU data residency |
| Redis | [Upstash Redis](https://upstash.com) EU region | Serverless, pay-per-use, GDPR-compliant, no cluster to manage |
| Object Storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) EU | S3-compatible, no egress fees, EU storage |

For **self-hosted NPO deployments** (Docker Compose), retain self-managed PostgreSQL 16 + PgBouncer + Redis 7 + MinIO. The S3 / Postgres compatible APIs ensure zero application code differences.

### Rationale

**Neon.tech vs alternatives:**
| Option | Verdict |
|---|---|
| Self-hosted Postgres (VPS) | ❌ Backup automation, failover, patching = ops overhead |
| Supabase PostgreSQL | ✅ Valid alternative — same Postgres, EU region. Rejected as *all-in-one* (see ADR-007), but usable as managed Postgres only |
| AWS RDS eu-west-3 | ⚠️ Valid but higher cost, more config surface |
| Neon.tech | ✅ Best DX, database branching for staging, built-in pooler, generous free tier, EU region |

**Upstash vs alternatives:**
| Option | Verdict |
|---|---|
| Self-hosted Redis Cluster (3 nodes) | ❌ Over-engineered for pre-scale; ops overhead |
| Elasticache (AWS) | ⚠️ Valid but high fixed cost, VPC dependency |
| Upstash | ✅ Serverless, pay-per-request, EU region, GDPR DPA available |

**Cloudflare R2 vs alternatives:**
| Option | Verdict |
|---|---|
| MinIO (self-hosted SaaS) | ❌ Storage admin + backup = ops overhead on SaaS |
| AWS S3 eu-west-3 | ✅ Valid, but egress fees add up (receipts, reports = read-heavy) |
| Cloudflare R2 | ✅ S3-compatible, **zero egress fees**, EU storage, DPA available |

### Consequences

- ✅ SaaS deployment simplified: 4 self-managed services (API, Worker, Web, Keycloak) instead of 8
- ✅ PostgreSQL feature parity: Neon supports all required extensions (uuid-ossp, pgcrypto, pg_trgm, ltree, pg_audit)
- ✅ GDPR data residency: all managed services offer EU-region storage with DPA
- ✅ WAL archiving, PITR, and read replicas available on Neon managed tier
- ⚠️ Neon free tier has cold-start latency (~500ms after inactivity) — use paid tier for production
- ⚠️ If monthly Neon cost exceeds ~€150/month, evaluate self-hosted Postgres on dedicated VPS

### Revisit when

- Monthly PostgreSQL cost on Neon exceeds the self-hosted equivalent (typically at €300+/month infra spend)
- A PostgreSQL extension is required that Neon does not support
- Data sovereignty requirement is stricter than EU-region managed (e.g., specific country jurisdiction required by an NPO's data protection authority)
- Upstash Redis latency is unacceptable for rate-limiting use case (measure p99 before switching)

---

## ADR-007: Reject Convex.dev and Supabase as All-in-One Backend Replacements

**Status:** Accepted
**Date:** 2026-03-09

### Context

Evaluated Convex.dev and Supabase as potential all-in-one backend platforms to reduce infrastructure complexity for Phase 0.

### Decision

Reject both as primary backend replacements. Supabase PostgreSQL remains a valid managed database option (equivalent to Neon.tech — see ADR-006).

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
| Supabase PostgreSQL only | ✅ Valid as managed Postgres (same as Neon.tech) — see ADR-006 |

### Consequences

- ✅ Keycloak retained — full auth feature set preserved (SAML 2.0, MFA, magic-link, brute-force protection)
- ✅ PostgreSQL with RLS, pg_audit, pg_trgm retained — GDPR tenant isolation and audit patterns preserved
- ✅ Self-hosted deployment path preserved — no cloud-only dependency
- ✅ TypeScript full-stack retained — shared types and monorepo benefits preserved (see ADR-002)
- ⚠️ Auth infrastructure requires self-hosting Keycloak — adds one container to manage in all deployment modes

---

## ADR-008: pg-boss over BullMQ + Redis (Recommended — pending decision)

- **Status**: Proposed
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)
- **Context**: The current stack uses BullMQ 5 + Redis for job queue processing. Redis is currently used for: (1) job queue backend, (2) rate limiting counters, (3) session cache. Removing Redis eliminates one infrastructure service and simplifies the deployment.
- **Decision**: Replace BullMQ + Redis with **pg-boss** (PostgreSQL-backed job queue) for Phase 0-3.
- **Rationale**:
  - pg-boss stores jobs in a dedicated `pgboss` schema in PostgreSQL — zero new infrastructure dependency
  - All job state (pending, active, completed, failed, retry) visible via standard SQL — directly monitorable without a separate dashboard
  - Transactional job creation: enqueue a job inside the same DB transaction as the mutation — stronger delivery guarantee than outbox pattern
  - TypeScript-native, well-maintained (1M+ weekly downloads), production-proven
  - Eliminates Redis from Phase 0-3 entirely (rate limiting can use in-memory or a simple PG table)
  - Neon.tech EU handles pg-boss jobs natively (just another schema)
  - **Code reduction**: removes `packages/worker/src/queues/index.ts` Redis config, simplifies connection management
- **Consequences**:
  - Slight performance difference vs Redis (PG-based queue has higher latency per job ~5-20ms vs ~1ms) — acceptable for NPO workloads (no sub-millisecond job SLA)
  - Redis re-introduction justified at Phase 4 only if job throughput exceeds ~1,000 jobs/min sustained
  - Rate limiting: use `express-rate-limit` with PostgreSQL store (or simple in-memory for Phase 0)
- **Rejected alternatives**:
  - **BullMQ + Redis** (current): requires running Redis — one more infra service to operate, monitor, and backup
  - **Inngest**: hosted only, adds vendor dependency
  - **Trigger.dev**: interesting but adds complexity for Phase 0
- **Migration path from BullMQ**: Direct swap in `packages/worker/`. Same job types, same processors — only the queue client changes (BullMQ Queue → pg-boss). Schema: `packages/shared/src/jobs/index.ts` types stay identical.

---

---

## ADR-009 — Scaleway as Primary SaaS Managed Cloud Provider

**Status**: Accepted
**Date**: 2026-03-30
**Deciders**: Magino (founder/architect)
**Supersedes**: ADR-006 (Neon.tech + Upstash + Cloudflare R2)

### Context

ADR-006 selected Neon.tech (PostgreSQL), Upstash (Redis), and Cloudflare R2 (storage) as managed SaaS components. While each service individually satisfied functional requirements, the combination results in three separate vendors with three separate DPAs, three separate billing relationships, and no unified observability layer.

The beneficiary data processing requirement (GDPR Art. 9 special category data) requires that AI inference for case notes and medical/social status run on EU infrastructure with no data leaving EU jurisdiction. The original plan specified self-hosted Ollama on a VPS — adding operational burden and GPU procurement complexity.

A holistic evaluation was conducted to identify a single European cloud provider covering compute, managed databases, cache, storage, observability, and AI inference in an integrated platform under a single GDPR-native contract.

### Options evaluated

| Criterion | **Scaleway** | UpCloud | OVH Cloud | Railway |
|---|---|---|---|---|
| Headquarters | Paris, FR 🇫🇷 | Helsinki, FI 🇫🇮 | Roubaix, FR 🇫🇷 | San Francisco, US 🇺🇸 |
| Regions | Paris, Amsterdam, Warsaw | 12 regions (EU + US) | Gravelines, Strasbourg | US/EU (limited) |
| Managed PostgreSQL | ✅ Native | ✅ Native | ✅ Native | ✅ (Postgres add-on) |
| Managed Redis | ✅ Native | ✅ Native | ✅ Native | ✅ (Redis add-on) |
| Object Storage | ✅ S3-compatible | ✅ S3-compatible | ✅ S3-compatible | ❌ No native storage |
| Integrated Observability | ✅ **Cockpit** (Grafana + Loki + Mimir + Tempo) | ❌ External only | ⚠️ Logs only | ❌ External only |
| Managed AI Inference EU | ✅ **Generative APIs** (Mistral, Llama) | ❌ No | ❌ No | ❌ No |
| GDPR / DPA | ✅ Native EU, single DPA | ✅ EU DPA | ✅ EU DPA | ⚠️ US company, EU DPA only |
| Pricing transparency | ✅ Fixed hourly | ✅ Fixed hourly | ✅ Fixed hourly | ⚠️ Usage-based, unpredictable |
| Self-hosted Keycloak support | ✅ Any VM | ✅ Any VM | ✅ Any VM | ⚠️ Container-only, no VMs |

### Decision

**Scaleway** is selected as the primary cloud provider for the Givernance SaaS managed offering, replacing the Neon.tech + Upstash + Cloudflare R2 tri-vendor setup (ADR-006).

### Rationale

1. **Cockpit (Grafana + Loki + Mimir + Tempo)**: Unified observability platform included natively. Scaleway-native metrics and logs are free; custom log ingestion billed at volume. Eliminates the need to self-host Grafana/Loki stacks or pay for a separate SaaS observability tool.

2. **Managed Inference EU (Mistral, Llama 3.1)**: Scaleway's Generative APIs provide pay-per-token and dedicated GPU inference endpoints hosted exclusively in EU datacenters. This directly replaces the self-hosted Ollama requirement for beneficiary data (GDPR Art. 9) — no GPU procurement, no ML ops overhead, full GDPR coverage under the Scaleway DPA.

3. **Single European cloud, single DPA**: All infrastructure (compute, database, cache, storage, inference, observability) operates under one GDPR-native contract from a French company. Eliminates the multi-vendor DPA management overhead of ADR-006.

4. **Managed PostgreSQL, Redis, Object Storage**: Direct functional equivalents to Neon.tech, Upstash, and Cloudflare R2. PostgreSQL supports all required extensions (uuid-ossp, pgcrypto, pg_trgm, ltree, pg_audit). Redis covers BullMQ job queue + rate limiting. Object Storage is S3-compatible.

5. **Predictable fixed pricing**: Hourly billed VMs and managed services with published pricing. No cold-start latency (vs Neon free tier), no per-request surprise billing (vs Upstash at scale).

6. **Keycloak compatibility**: Scaleway VMs support self-hosted Keycloak in all configurations — single instance (Phase 0) and HA pair (Phase 1+). Keycloak remains self-hosted; no managed identity provider introduced.

### Cost estimates

#### Phase 0 — Dev/staging (~67€/month)

| Service | Config | Cost |
|---|---|---|
| VM Small (1vCPU/2GB) — API + Worker | 1 instance | ~12€ |
| Managed PostgreSQL | 1vCPU/2GB/20GB | ~7€ |
| Managed Redis | 2GB | ~35€ |
| Object Storage | 10GB | ~1€ |
| Keycloak VM Small (1vCPU/2GB) | 1 instance | ~12€ |
| Cockpit (Scaleway-native metrics/logs) | Free for Scaleway data | 0€ |
| **Total** | | **~67€/month** |

#### Phase 1 — 1 NPO pilot (~281€/month)

| Service | Config | Cost |
|---|---|---|
| VM Medium (4vCPU/8GB) — API | 2 replicas | ~90€ |
| VM Small — BullMQ Worker | 1 instance | ~12€ |
| VM Small — Next.js Web | 1 instance | ~12€ |
| Managed PostgreSQL | 2vCPU/4GB/96GB + read replica | ~74€ |
| Managed Redis | 2GB | ~35€ |
| Object Storage | 50GB | ~1€ |
| Keycloak HA (VM Medium × 2) | 2 instances | ~45€ |
| Cockpit custom logs | ~5GB/month | ~2€ |
| Load Balancer + Flexible IPs | — | ~10€ |
| **Total** | | **~281€/month** |

> **Budget alternative**: Keycloak co-located on the API VM → ~180€/month (recommended for early pilots).

#### Phase 1 extended — 5–10 NPOs (~458€/month)

| Service | Config | Cost |
|---|---|---|
| VM Medium (4vCPU/8GB) — API | 3 replicas | ~135€ |
| VM Small — BullMQ Worker | 2 instances | ~24€ |
| VM Small — Next.js Web | 2 instances | ~24€ |
| Managed PostgreSQL | 4vCPU/8GB/200GB + replica | ~150€ |
| Managed Redis | 4GB | ~55€ |
| Object Storage | 200GB | ~3€ |
| Keycloak HA (VM Medium × 2) | 2 instances | ~45€ |
| Cockpit custom logs | ~20GB/month | ~7€ |
| Load Balancer + Flexible IPs | — | ~15€ |
| **Total** | | **~458€/month** |

#### AI Inference (optional add-on)

| Option | Config | Cost |
|---|---|---|
| Generative API (pay-per-token) | ~50M tokens | ~10–20€ |
| Managed Inference dédié (Llama 3.1 8B, L4 GPU) | dedicated endpoint | ~679€ |

> **Recommendation**: Start with pay-per-token Generative API. Migrate to dedicated endpoint only if token volume justifies it (>200M tokens/month).

### Consequences

- ✅ **Replaces** Neon.tech → Scaleway Managed PostgreSQL EU
- ✅ **Replaces** Upstash Redis → Scaleway Managed Redis EU
- ✅ **Replaces** Cloudflare R2 → Scaleway Object Storage (S3-compatible API, zero application changes)
- ✅ **Replaces** self-hosted Ollama → Scaleway Generative APIs (Mistral, Llama 3.1) for beneficiary data AI (GDPR Art. 9 compliant)
- ✅ **Adds** Scaleway Cockpit: Grafana dashboards, Loki log aggregation, Mimir metrics, Tempo traces — eliminates need for self-hosted observability stack
- ✅ **Single vendor DPA** replaces three separate DPAs (Neon, Upstash, Cloudflare)
- ✅ Keycloak remains **self-hosted on Scaleway VMs** in all configurations — no managed identity provider
- ⚠️ NATS JetStream remains **Phase 4+** — no change to the BullMQ + Redis outbox pipeline for Phase 0-3
- ⚠️ Self-hosted Docker Compose deployment (NPO on-premises) is **unchanged** — continues to use PostgreSQL 16 + Redis 7 + MinIO locally

### Revisit criteria

- Scaleway Managed PostgreSQL pricing increases beyond the self-hosted break-even point (~150€/month for a dedicated VPS with equivalent capacity)
- A required PostgreSQL extension is not supported by Scaleway Managed PostgreSQL
- An NPO's data protection authority requires jurisdiction stricter than EU-region (e.g., Swiss DPA requiring Swiss-only infrastructure)
- Scaleway Generative API adds unacceptable latency for interactive AI features (measure p95 before switching to dedicated endpoint)
- NATS JetStream is introduced in Phase 4 — re-evaluate whether Scaleway supports managed NATS or if self-hosted NATS cluster on Scaleway VMs is preferred
- Phase 4 GPU inference demand justifies dedicated Scaleway Managed Inference endpoint (~679€/month) over pay-per-token model

---

*ADRs are append-only. To supersede a decision, add a new ADR referencing the one it replaces, and update the superseded ADR's status to "Superseded by ADR-XXX".*
