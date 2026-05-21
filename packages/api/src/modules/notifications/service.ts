/**
 * In-app notification centre — read/write service (Epic #363, GLO-004).
 *
 * Recipient-scoped (NOT just tenant-scoped): every query filters
 * `notifications.user_id = currentUserId` in addition to the RLS-
 * enforced `org_id = currentTenantId` boundary. A tenant member can
 * never read another member's notifications, even within the same
 * tenant. The same applies to mark-read mutations.
 *
 * Soft-delete universal (ADR-021): every read filters
 * `deleted_at IS NULL`; deletion sets `deleted_at` instead of
 * physically removing the row.
 */

import {
  getNotificationDescriptor,
  isNotificationType,
  NOTIFICATION_TYPE_REGISTRY,
  type NotificationType,
} from "@givernance/shared/constants";
import {
  type Notification,
  type NotificationPreference,
  notificationPreferences,
  notifications,
} from "@givernance/shared/schema";
import { and, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface ListNotificationsQuery {
  /**
   * Cursor — opaque base64-encoded `(created_at, id)` tuple. Returned
   * as `nextCursor` in the response when more rows exist.
   */
  cursor?: string;
  /** Max rows per page. Clamped to [1, 50] by the route schema. */
  limit?: number;
  /**
   * Filter by `notifications.type`. Validated by the route as an
   * enum-union; unknown values fail 400 before reaching here.
   */
  type?: NotificationType;
  /** When `true`, only rows with `read_at IS NULL`. */
  onlyUnread?: boolean;
}

export interface ListNotificationsResult {
  data: Notification[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function listNotifications(
  orgId: string,
  userId: string,
  query: ListNotificationsQuery,
): Promise<ListNotificationsResult> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = decodeCursor(query.cursor);

  return withTenantContext(orgId, async (tx) => {
    const conditions = [
      eq(notifications.userId, userId),
      // Panel hides rows whose recipient opted out of in-app at write
      // time (migration 0056 — decouples in_app from email_digest).
      // `panel_visible = true` is frozen, so a later in_app toggle does
      // NOT retroactively reveal historical rows.
      eq(notifications.panelVisible, true),
      isNull(notifications.deletedAt),
      // Default view hides archived rows. A `?includeArchived=true`
      // is a follow-up (issue #363 § 4 out-of-scope: archive
      // management UI).
      isNull(notifications.archivedAt),
    ];
    if (query.type) {
      conditions.push(eq(notifications.type, query.type));
    }
    if (query.onlyUnread) {
      conditions.push(isNull(notifications.readAt));
    }
    if (cursor) {
      // (created_at, id) tuple ordering — strict less-than on the
      // composite. Postgres `row(a, b) < row(c, d)` evaluates exactly
      // this. Using `or` of two conjunctions keeps Drizzle happy. The
      // `or` helper returns `SQL | undefined`; we know both branches
      // are present, so guard with an explicit truthy push rather
      // than a non-null assertion (lint/style/noNonNullAssertion).
      const cursorClause = or(
        lt(notifications.createdAt, cursor.createdAt),
        and(eq(notifications.createdAt, cursor.createdAt), lt(notifications.id, cursor.id)),
      );
      if (cursorClause) conditions.push(cursorClause);
    }

    // Fetch one extra to know if there's a next page without a
    // second COUNT query.
    const rows = await tx
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];
    const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : null;

    return { data, nextCursor };
  });
}

export async function getUnreadCount(orgId: string, userId: string): Promise<number> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          // Bell badge mirrors the panel — see `listNotifications`.
          eq(notifications.panelVisible, true),
          isNull(notifications.readAt),
          isNull(notifications.deletedAt),
          isNull(notifications.archivedAt),
        ),
      );
    return Number(row?.value ?? 0);
  });
}

/**
 * Mark one notification as read. Returns the updated row or `null`
 * if the id didn't match (either wrong tenant, wrong user, or
 * deleted). Idempotent — calling on an already-read row is a no-op
 * that returns the row unchanged.
 */
export async function markRead(
  orgId: string,
  userId: string,
  id: string,
): Promise<Notification | null> {
  return withTenantContext(orgId, async (tx) => {
    // First check the row belongs to the caller. Using a SELECT-then-
    // UPDATE pattern (rather than UPDATE…RETURNING with a WHERE clause
    // that includes user_id) so a 404 vs 200-no-op is distinguishable
    // by the route handler.
    const [existing] = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          // Only panel-visible rows can be operated on from the bell UI.
          // A row stored solely for the email digest is invisible to the
          // panel; mark-read on its id is 404 (anti-disclosure).
          eq(notifications.panelVisible, true),
          isNull(notifications.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) return null;
    if (existing.readAt) return existing;

    const [updated] = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, id))
      .returning();
    return updated ?? existing;
  });
}

/**
 * Mark every unread notification for this user as read. Returns the
 * count. Idempotent — second call returns 0.
 */
export async function markAllRead(orgId: string, userId: string): Promise<number> {
  return withTenantContext(orgId, async (tx) => {
    const rows = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          // Same scope as the panel — don't pre-read digest-only rows
          // since the user can't see them. Their unread state is
          // irrelevant for the bell and "mark all read" is a panel
          // affordance.
          eq(notifications.panelVisible, true),
          isNull(notifications.readAt),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  });
}

/**
 * Soft-delete one notification. Sets `deleted_at`; the row stays for
 * audit. Returns `null` if not found / not owned.
 */
export async function softDeleteNotification(
  orgId: string,
  userId: string,
  id: string,
): Promise<Notification | null> {
  return withTenantContext(orgId, async (tx) => {
    const [updated] = await tx
      .update(notifications)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          // Panel-only affordance — see `markRead`.
          eq(notifications.panelVisible, true),
          isNull(notifications.deletedAt),
        ),
      )
      .returning();
    return updated ?? null;
  });
}

// ─── Preferences ──────────────────────────────────────────────────────

export interface PreferencesView {
  data: Array<{
    type: NotificationType;
    inApp: boolean;
    emailDigest: boolean;
    /** Whether this is the registry default (no explicit row exists). */
    isDefault: boolean;
  }>;
}

/**
 * Return the user's effective preferences: explicit rows merged with
 * per-type defaults from `NOTIFICATION_TYPE_REGISTRY`. The shape is
 * a closed set (one entry per registered type) so the web UI can
 * render the toggle grid without an N+1.
 */
export async function listPreferences(orgId: string, userId: string): Promise<PreferencesView> {
  return withTenantContext(orgId, async (tx) => {
    const rows = (await tx
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))) as NotificationPreference[];
    const explicit = new Map<string, NotificationPreference>();
    for (const row of rows) {
      explicit.set(row.type, row);
    }
    const data = NOTIFICATION_TYPE_REGISTRY.map((descriptor) => {
      const row = explicit.get(descriptor.key);
      if (row) {
        return {
          type: descriptor.key,
          inApp: row.inApp,
          emailDigest: row.emailDigest,
          isDefault: false,
        };
      }
      return {
        type: descriptor.key,
        inApp: descriptor.defaultInApp,
        emailDigest: descriptor.defaultEmailDigest,
        isDefault: true,
      };
    });
    return { data };
  });
}

export interface UpdatePreferenceInput {
  inApp: boolean;
  emailDigest: boolean;
}

/**
 * Upsert one preference row. Returns the resolved view (matches
 * `listPreferences` shape) so the client can re-render without a
 * second GET.
 */
export async function updatePreference(
  orgId: string,
  userId: string,
  type: string,
  input: UpdatePreferenceInput,
): Promise<{
  type: NotificationType;
  inApp: boolean;
  emailDigest: boolean;
  isDefault: false;
} | null> {
  if (!isNotificationType(type)) return null;
  const descriptor = getNotificationDescriptor(type);
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .insert(notificationPreferences)
      .values({
        orgId,
        userId,
        type: descriptor.key,
        inApp: input.inApp,
        emailDigest: input.emailDigest,
      })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.type],
        set: {
          inApp: input.inApp,
          emailDigest: input.emailDigest,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) return null;
    return {
      type: descriptor.key,
      inApp: row.inApp,
      emailDigest: row.emailDigest,
      isDefault: false,
    };
  });
}

/**
 * Stream new notifications for the SSE endpoint. Polls every
 * `intervalMs` and yields rows created after `since`. Stops when the
 * caller's AbortSignal fires (the route closes the connection).
 *
 * `isStillAuthorised` is called every iteration so a flag flip /
 * user revocation mid-stream tears down the connection within one
 * polling interval (Security H2). The caller passes a closure that
 * re-validates against the flag service + active-row check; we keep
 * the check at the boundary so the service stays DB-only.
 *
 * Polling-over-LISTEN was chosen for the spike — see ADR-031. The
 * loop here is intentionally simple; a future migration to PG
 * LISTEN/NOTIFY drops in behind the same yield contract.
 */
export async function* streamNotifications(
  orgId: string,
  userId: string,
  options: {
    signal: AbortSignal;
    intervalMs: number;
    since?: Date;
    /** Returning `false` aborts the stream — see header. */
    isStillAuthorised?: () => Promise<boolean>;
  },
): AsyncGenerator<Notification, void, unknown> {
  let cursor = options.since ?? new Date();
  while (!options.signal.aborted) {
    if (options.isStillAuthorised) {
      const ok = await options.isStillAuthorised();
      if (!ok) break;
    }
    const fresh = await withTenantContext(orgId, async (tx) => {
      return tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            // SSE stream feeds the same panel — skip digest-only rows
            // so the bell badge doesn't tick up for something the user
            // can't see.
            eq(notifications.panelVisible, true),
            isNull(notifications.deletedAt),
            sql`${notifications.createdAt} > ${cursor.toISOString()}`,
          ),
        )
        .orderBy(notifications.createdAt);
    });
    for (const row of fresh) {
      yield row;
      cursor = row.createdAt;
    }
    if (options.signal.aborted) break;
    await sleep(options.intervalMs, options.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Cursor codec ─────────────────────────────────────────────────────

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): DecodedCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const [iso, id] = decoded.split("|");
    if (!iso || !id) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    // Validate `id` as a UUID — a forged cursor with a 10 k-char `id`
    // would otherwise ship to PG (Security M4 / Data L1). The cursor
    // can't bypass `user_id = currentUserId` regardless (WHERE clause
    // is unconditional), but rejecting nonsense at the boundary saves
    // a round-trip on tampering attempts.
    if (!UUID_RE.test(id)) return null;
    return { createdAt: date, id };
  } catch {
    return null;
  }
}
