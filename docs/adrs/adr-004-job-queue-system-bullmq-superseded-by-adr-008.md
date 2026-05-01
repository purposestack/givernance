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

