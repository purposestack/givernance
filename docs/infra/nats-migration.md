# NATS JetStream Migration Plan

> **ADR-005** — Event Transport: BullMQ (Phase 0–3) → NATS JetStream (Phase 4+)

## Current State (Phase 0–3)

The event bus uses **BullMQ** (Redis-backed) as the transport layer:

- **Outbox pattern**: Route handlers insert domain events into the `outbox_events` PostgreSQL table within the same transaction as the business entity mutation.
- **Outbox relay** (`packages/worker/src/outbox-relay.ts`): Polls `outbox_events` every 500ms, enqueues pending events into the `givernance_events` BullMQ queue using `SELECT FOR UPDATE SKIP LOCKED` to prevent duplicate delivery.
- **Event worker** (`packages/worker/src/worker.ts`): BullMQ worker processes domain events from the queue (concurrency: 10).
- **EventBus abstraction** (`packages/api/src/lib/events.ts`): Thin wrapper over BullMQ. All callers use the `EventBus` interface, not BullMQ directly.

## Why Migrate to NATS JetStream?

| Capability | BullMQ | NATS JetStream |
|---|---|---|
| Multi-subscriber fan-out | ❌ Single consumer per queue | ✅ Multiple consumers per stream |
| Event replay | ❌ No persistence | ✅ Replay from any sequence |
| Cross-service communication | ⚠️ Shared Redis | ✅ Native pub/sub with subjects |
| Backpressure | ✅ BullMQ built-in | ✅ Consumer ack/nak |
| Operational complexity | Low (Redis) | Medium (NATS cluster) |

## Migration Steps (Phase 4)

### 1. Add NATS to Infrastructure

```yaml
# docker-compose.yml
nats:
  image: nats:2-alpine
  command: --jetstream --store_dir /data
  ports:
    - "4222:4222"  # Client
    - "8222:8222"  # Monitoring
  volumes:
    - natsdata:/data
```

### 2. Swap EventBus Implementation

Only `packages/api/src/lib/events.ts` needs to change. Replace the BullMQ queue with a NATS JetStream publisher:

```typescript
// Before (Phase 0–3)
const eventsQueue = new Queue(QUEUE_NAMES.EVENTS, { connection: redis });

// After (Phase 4+)
const nc = await connect({ servers: process.env.NATS_URL });
const js = nc.jetstream();
```

### 3. Swap Outbox Relay

The outbox relay (`packages/worker/src/outbox-relay.ts`) changes from `eventsQueue.add()` to `js.publish()`.

### 4. Swap Event Consumer

The worker's event processor changes from a BullMQ `Worker` to a NATS JetStream `consumer.consume()`.

### 5. Dual-Run Period

Run both BullMQ and NATS consumers for 1–2 weeks during the transition. The outbox relay publishes to both transports. Once NATS is confirmed stable, remove BullMQ.

### 6. Remove BullMQ Event Queue

- Remove the `givernance_events` BullMQ queue
- Keep BullMQ for non-event job queues (receipts, emails, exports, GDPR) until Phase 5+

## Files Affected

| File | Change |
|---|---|
| `packages/api/src/lib/events.ts` | Replace BullMQ → NATS JetStream publisher |
| `packages/worker/src/outbox-relay.ts` | Replace `eventsQueue.add()` → `js.publish()` |
| `packages/worker/src/worker.ts` | Replace BullMQ event worker → NATS consumer |
| `packages/api/src/lib/nats.ts` | Activate (currently Phase 4 placeholder) |
| `docker-compose.yml` | Add NATS service |

## Rollback

If NATS introduces issues, revert `events.ts` and `outbox-relay.ts` to use BullMQ. The outbox table and EventBus interface remain unchanged — only the transport layer swaps.
