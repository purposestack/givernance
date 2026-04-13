/**
 * EventBus — publishes domain events to BullMQ (Phase 0–3).
 *
 * Architecture note (ADR-005):
 * Phase 0–3 uses BullMQ (Redis-backed) as the event transport.
 * Phase 4+ will swap this implementation to NATS JetStream for
 * multi-subscriber fan-out, event replay, and cross-service
 * communication. The swap requires changing only this file —
 * all callers use the EventBus interface, not BullMQ directly.
 *
 * Usage in route handlers:
 *   1. Insert the business entity + outbox row in a single DB transaction.
 *   2. The outbox relay (packages/worker/src/outbox-relay.ts) polls the
 *      outbox table and calls eventBus.publish() to enqueue into BullMQ.
 *   3. The event worker processes events from the BullMQ queue.
 */

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { Queue } from "bullmq";
import { redis } from "./redis.js";

const eventsQueue = new Queue(QUEUE_NAMES.EVENTS, { connection: redis });

export interface EventBusMessage {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
}

export const eventBus = {
  /**
   * Publish a domain event to the BullMQ events queue.
   * In Phase 4+ this will publish to a NATS JetStream subject instead.
   */
  async publish(event: EventBusMessage): Promise<void> {
    await eventsQueue.add(event.type, event, {
      jobId: event.id,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  },

  /** Gracefully close the underlying queue connection. */
  async close(): Promise<void> {
    await eventsQueue.close();
  },
};
