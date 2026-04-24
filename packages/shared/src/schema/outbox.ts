/**
 * Transactional Outbox table — guarantees domain events are persisted
 * in the same Postgres transaction as the business entity mutation.
 *
 * The outbox relay polls this table and enqueues pending events into
 * BullMQ (Phase 0–3) or NATS JetStream (Phase 4+).
 */

import { jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  type: varchar("type", { length: 255 }).notNull(),
  payload: jsonb("payload").notNull(),
  /**
   * W3C trace-context propagation for distributed tracing across the outbox
   * boundary. The relay reads `traceparent` and attaches it to the BullMQ job
   * so the worker's pino logger can seed its `traceId` field. Type is
   * {@link OutboxMetadata} — kept here as the single source of truth so API
   * and relay never drift (PR #142 review — H4).
   */
  metadata: jsonb("metadata").$type<OutboxMetadata | null>(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/**
 * Shape of `outbox_events.metadata` — W3C trace-context plus future hooks.
 * `traceparent` is optional on read so pre-PR rows (metadata = null OR {})
 * deserialise cleanly; writers should always populate it when available.
 */
export interface OutboxMetadata {
  traceparent?: string;
  tracestate?: string;
}
