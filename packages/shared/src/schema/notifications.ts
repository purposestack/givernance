/**
 * In-app notification centre — schema (Epic #363, GLO-004).
 *
 * One row per (recipient, event). Tenant-scoped, RLS-isolated. The
 * worker writes rows via `withWorkerContext` after fanning out an
 * outbox event to N recipients; the API reads them via
 * `withTenantContext`.
 *
 * Why a varchar `type` instead of a Postgres enum:
 *   - Adding a notification type ("campaign_postal_export_completed")
 *     is a code change in `NOTIFICATION_TYPE_VALUES` + a producer
 *     wiring — never a migration. A Postgres enum would lock us into
 *     `ALTER TYPE ... ADD VALUE` for every new type.
 *   - The CHECK constraint in migration 0055 pins the shape
 *     (lowercase dotted-namespace) so a buggy producer can't
 *     insert garbage.
 *
 * Why `title_key` + `body_key` + `params` instead of frozen `text`:
 *   - A French user sees French even when the worker writing the row
 *     processed an English request. i18n interpolation happens at the
 *     READ boundary (web panel + email digest), not at write time.
 *
 * Soft-delete is universal (ADR-021 / `feedback_soft_delete_universal`):
 * a panel "delete" sets `deleted_at`, the row stays for audit + GDPR
 * DSR replay.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { tenants, users } from "./index.js";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Tenant boundary — RLS policy keys on this column. The producer
     * derives this from the outbox event's `tenant_id`.
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * Originating outbox event id. Natural idempotency key paired
     * with `user_id` + `type` — an outbox redelivery (relay retry,
     * worker crash mid-fanout) does NOT produce a second row for the
     * same recipient. The fanout worker passes the event id from
     * BullMQ's `job.data`. Same defence pattern as bulk-email's
     * `bulk-email-${outboxId}` jobId in `worker.ts`. No FK to the
     * outbox table — the row may be GC'd by a future retention
     * sweep, but our audit trail keys on the id string itself.
     */
    outboxEventId: uuid("outbox_event_id").notNull(),
    /**
     * Recipient. `SET NULL` on user purge so a GDPR-erased account
     * doesn't FK-block historical notifications — the orphaned rows
     * are then garbage-collected by the universal soft-delete sweep
     * (out of scope for this Epic).
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Notification type — discriminator. Pinned by the CHECK
     * constraint in migration 0055 to `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`.
     * Source of truth = `NOTIFICATION_TYPE_VALUES` in
     * `packages/shared/src/constants/notifications.ts`.
     */
    type: varchar("type", { length: 64 }).notNull(),
    /**
     * i18n title key. Resolved against the user's locale at READ time
     * (not at write time) so a French recipient sees French even if
     * the worker that wrote the row was processing an English session.
     */
    titleKey: varchar("title_key", { length: 128 }).notNull(),
    /**
     * i18n body key. Same READ-time resolution as `titleKey`.
     */
    bodyKey: varchar("body_key", { length: 128 }).notNull(),
    /**
     * Interpolation params for the i18n templates. Defaults to `{}`.
     * GDPR posture (see `docs/27-notifications.md` § GDPR): only
     * opaque ids + non-sensitive counters belong here; full donor
     * names / emails are dereferenced client-side via `link_url`.
     */
    params: jsonb("params").notNull().default({}),
    /**
     * Relative path (e.g. `/donations/<uuid>`). Frontend prepends
     * APP_URL. Absolute URLs are rejected by the CHECK constraint
     * (`link_url LIKE '/%'`) so a custom-subdomain tenant (Epic #279
     * follow-up) sees the right host.
     */
    linkUrl: text("link_url"),
    /**
     * Frozen panel-visibility decision taken at write time (migration
     * 0056). `true` when the recipient had `notification_preferences.in_app`
     * effective-true for the type at fanout time. The fanout still
     * writes a row when ONLY `email_digest` is enabled (so the digest
     * worker can read it) — `panel_visible = false` keeps that row out
     * of the bell + panel.
     *
     * Frozen, NOT dynamic: a later `in_app=true` toggle does not
     * retroactively reveal historical rows. The panel + unread-count
     * queries add `panel_visible = true` to their WHERE clauses.
     */
    panelVisible: boolean("panel_visible").notNull().default(true),
    /** NULL until the user marks read (single read or read-all). */
    readAt: timestamp("read_at", { withTimezone: true }),
    /**
     * NULL until archived from the panel. Archived ≠ deleted: a row
     * can be read AND archived; the panel hides archived rows from
     * the default view.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Soft-delete — see file header. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Per-user, time-ordered listing (panel + email digest). */
    userCreatedIdx: index("notifications_user_created_idx").on(table.userId, table.createdAt),
    /**
     * Bell-badge unread-count — partial index in the migration. Not
     * modelled here (Drizzle does not yet emit partial indexes in
     * `pgTable`). Migration 0055 is the source of truth.
     */
    orgCreatedIdx: index("notifications_org_created_idx").on(table.orgId, table.createdAt),
    /** Natural idempotency key — see `outboxEventId` column comment. */
    outboxRecipientTypeUnique: unique("notifications_outbox_recipient_type_unique").on(
      table.outboxEventId,
      table.userId,
      table.type,
    ),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/**
 * Per (user, type) channel matrix. Missing rows fall back to the
 * per-type defaults in `NOTIFICATION_TYPE_DEFAULTS` — saves an
 * INSERT for every user on registration.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 64 }).notNull(),
    /**
     * `false` suppresses the type at WRITE time — the fanout worker
     * does not insert a `notifications` row for a user whose
     * preference for this type is off. Re-enabling the channel later
     * affects FUTURE events only; historical events the user opted
     * out of are gone. This is the simpler contract: storage stays
     * lean and the unread count never lags an opt-out decision.
     * (Reviewed by Worker SRE — PR #393 CRIT-2 fix.)
     */
    inApp: boolean("in_app").notNull().default(true),
    /**
     * `true` includes the type in the weekly digest worker (Phase 5;
     * opt-in). Defaults to false — donors and operators rarely want
     * a second email for every panel ping.
     */
    emailDigest: boolean("email_digest").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Natural upsert key — one row per (user, type). */
    userTypeUnique: unique("notification_preferences_user_type_unique").on(
      table.userId,
      table.type,
    ),
    userIdx: index("notification_preferences_user_idx").on(table.userId),
  }),
);

export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;
