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

