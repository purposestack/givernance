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

