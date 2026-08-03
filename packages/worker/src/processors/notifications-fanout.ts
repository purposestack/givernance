/**
 * Notification fanout — single producer for in-app notifications
 * (Epic #363, GLO-004).
 *
 * Subscribes to outbox events alongside the existing `routeDomainEvent`
 * routing decision and writes `notifications` rows for the curated
 * Phase 1 event list:
 *
 *   - `donation.created`               → notify every org_admin
 *   - `invitation.created`             → notify every org_admin
 *   - `invitation.resent`              → notify every org_admin
 *   - `branding.activate_logo`         → notify every org_admin
 *   - `campaign.postal_export_requested` → notify the requester
 *   - `communication.bulk_email_requested` → notify the requester
 *
 * Recipient resolution lives here (not in the API producer) because
 * the same outbox event may fan out to multiple recipients (every
 * org_admin of the tenant), and the producer doesn't have that list.
 *
 * Per-user opt-out semantics — **WRITE-time suppression**. A user
 * with `notification_preferences.in_app = false` for the type does
 * NOT receive a notification row. Re-enabling the channel later
 * affects FUTURE events only — historical alerts the user opted out
 * of are gone. Reviewed by the Worker SRE agent (PR #393 CRIT-2 fix);
 * the schema doc is kept in sync with this contract.
 *
 * Idempotency — every row carries `outbox_event_id` and the table has
 * a UNIQUE (outbox_event_id, user_id, type) constraint. An outbox
 * redelivery (relay retry, worker crash mid-fanout) hits
 * `ON CONFLICT DO NOTHING` and silently no-ops rather than producing
 * a duplicate row per recipient.
 *
 * Critical-path budget — the fanout runs inside the existing
 * `processDomainEvent` switch, ahead of receipt-PDF and postal-export
 * routing. We wrap the work in a 2 s `Promise.race` budget so a slow
 * PG doesn't propagate latency to those downstream side-effects.
 *
 * Soft errors only — a fanout failure is logged but never thrown back
 * up. The existing routing decision (donation → receipt, branding →
 * activate, etc.) is the hard contract; notifications are best-effort
 * UX. A future Phase moves fanout to a dedicated retry-bearing queue.
 */

import { getNotificationDescriptor, type NotificationType } from "@givernance/shared/constants";
import { BRANDING_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  type NewNotification,
  notificationPreferences,
  notifications,
  users,
} from "@givernance/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { extractTraceId } from "../lib/trace-context.js";

export interface FanoutInput {
  /** Outbox event id (logged for correlation). */
  outboxId: string;
  /** Tenant scope. */
  tenantId: string;
  /** Outbox `type` discriminator. */
  type: string;
  /** Outbox `payload`. */
  payload: Record<string, unknown>;
  /** W3C trace context for logger correlation. */
  traceparent?: string;
}

/**
 * Plan a fanout — pure function for unit testing. Translates an
 * outbox event into a list of (notificationType, recipientFilter,
 * titleKey, bodyKey, params, linkUrl) entries. The filter is applied
 * at INSERT time by the recipient resolver below.
 */
type RecipientFilter = { kind: "all_org_admins" } | { kind: "specific_user"; userId: string };

interface FanoutPlanEntry {
  type: NotificationType;
  recipients: RecipientFilter;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  linkUrl: string | null;
}

export function planFanout(input: FanoutInput): FanoutPlanEntry[] {
  const { type, payload } = input;

  if (type === "donation.created") {
    const donationId = stringOrNull(payload.donationId);
    if (!donationId) return [];
    const amountCents = numberOrNull(payload.amountCents);
    const currency = stringOrNull(payload.currency);
    return [
      {
        type: "donation.received",
        recipients: { kind: "all_org_admins" },
        titleKey: getNotificationDescriptor("donation.received").titleKey,
        bodyKey: getNotificationDescriptor("donation.received").bodyKey,
        params: {
          donationId,
          amountCents,
          currency,
        },
        linkUrl: `/donations/${donationId}`,
      },
    ];
  }

  if (type === "invitation.created" || type === "invitation.resent") {
    const invitationId = stringOrNull(payload.invitationId);
    if (!invitationId) return [];
    const notificationType: NotificationType =
      type === "invitation.created" ? "invitation.created" : "invitation.resent";
    return [
      {
        type: notificationType,
        recipients: { kind: "all_org_admins" },
        titleKey: getNotificationDescriptor(notificationType).titleKey,
        bodyKey: getNotificationDescriptor(notificationType).bodyKey,
        params: {
          invitationId,
        },
        linkUrl: `/settings/members`,
      },
    ];
  }

  if (type === BRANDING_EVENT_TYPES.ACTIVATE_LOGO) {
    return [
      {
        type: "branding.logo_synced",
        recipients: { kind: "all_org_admins" },
        titleKey: getNotificationDescriptor("branding.logo_synced").titleKey,
        bodyKey: getNotificationDescriptor("branding.logo_synced").bodyKey,
        params: {},
        linkUrl: `/settings`,
      },
    ];
  }

  if (type === "campaign.postal_export_requested") {
    const requestedBy = stringOrNull(payload.requestedBy);
    const campaignId = stringOrNull(payload.campaignId);
    const exportId = stringOrNull(payload.exportId);
    return [
      {
        type: "postal_export.queued",
        recipients: requestedBy
          ? { kind: "specific_user", userId: requestedBy }
          : { kind: "all_org_admins" },
        titleKey: getNotificationDescriptor("postal_export.queued").titleKey,
        bodyKey: getNotificationDescriptor("postal_export.queued").bodyKey,
        params: {
          campaignId,
          exportId,
        },
        linkUrl: campaignId ? `/campaigns/${campaignId}` : null,
      },
    ];
  }

  if (type === "communication.bulk_email_requested") {
    const requestedBy = stringOrNull(payload.requestedBy);
    const bulkEmailJobId = stringOrNull(payload.bulkEmailJobId);
    return [
      {
        type: "bulk_email.queued",
        recipients: requestedBy
          ? { kind: "specific_user", userId: requestedBy }
          : { kind: "all_org_admins" },
        titleKey: getNotificationDescriptor("bulk_email.queued").titleKey,
        bodyKey: getNotificationDescriptor("bulk_email.queued").bodyKey,
        params: {
          bulkEmailJobId,
        },
        linkUrl: `/constituents`,
      },
    ];
  }

  return [];
}

/**
 * Run the fanout for one outbox event. Never throws — logs and
 * returns instead so the caller's existing routing decision is not
 * blocked.
 */
/**
 * Critical-path budget for the fanout work (ms). The fanout runs
 * inline ahead of receipt-PDF + postal-export routing in
 * `processDomainEvent`; a slow PG must not propagate latency to
 * those downstream side-effects. Reviewed by Worker SRE (HIGH-1).
 */
const FANOUT_TIMEOUT_MS = 2_000;

export async function fanoutNotifications(input: FanoutInput): Promise<void> {
  const log = jobLogger({
    tenantId: input.tenantId,
    jobId: input.outboxId,
    traceId: extractTraceId(input.traceparent) ?? input.outboxId,
  });

  const plan = planFanout(input);
  if (plan.length === 0) {
    return;
  }

  try {
    await Promise.race([
      runFanoutPlan(input, plan),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Fanout timeout after ${FANOUT_TIMEOUT_MS} ms`)),
          FANOUT_TIMEOUT_MS,
        ),
      ),
    ]);

    log.debug({ eventType: input.type, planSize: plan.length }, "Notification fanout completed");
  } catch (err) {
    // Soft-fail — see file header. Notifications are UX, not contract.
    log.error(
      { err, eventType: input.type },
      "Notification fanout failed — continuing with existing routing",
    );
  }
}

async function runFanoutPlan(input: FanoutInput, plan: FanoutPlanEntry[]): Promise<void> {
  await withWorkerContext(input.tenantId, async (tx) => {
    for (const entry of plan) {
      const recipientUserIds = await resolveRecipients(tx, entry.recipients, input.tenantId);
      if (recipientUserIds.length === 0) continue;

      // Honour per-user preferences across BOTH channels. A user is a
      // recipient when EITHER `in_app` OR `email_digest` is enabled for
      // the type — coupling the two at write time (the original Epic
      // #363 contract) silently broke email-only opt-ins. The row's
      // `panel_visible` column records the panel decision so the bell
      // hides it while the digest worker can still pick it up.
      // Migration 0058 captures the rationale.
      const channels = await resolveChannels(tx, recipientUserIds, entry.type, input.tenantId);
      if (channels.length === 0) continue;

      const rows: NewNotification[] = channels.map(({ userId, inApp }) => ({
        orgId: input.tenantId,
        outboxEventId: input.outboxId,
        userId,
        type: entry.type,
        titleKey: entry.titleKey,
        bodyKey: entry.bodyKey,
        params: entry.params,
        linkUrl: entry.linkUrl,
        panelVisible: inApp,
      }));

      // `ON CONFLICT DO NOTHING` — the natural unique key
      // (outbox_event_id, user_id, type) catches outbox redeliveries
      // so a retry doesn't produce a second row per recipient.
      await tx.insert(notifications).values(rows).onConflictDoNothing();
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function resolveRecipients(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is awkward to spell out — same shape as in API service
  tx: any,
  filter: RecipientFilter,
  tenantId: string,
): Promise<string[]> {
  // Defence in depth: every recipient query carries an explicit
  // `eq(users.orgId, tenantId)` predicate, never relying on RLS as
  // the sole barrier. Reason: a deploy misconfig (issue #430,
  // 2026-05-23 incident) flipped `DATABASE_URL_APP` to the owner
  // role on staging — RLS was bypassed across the stack, and the
  // RLS-only `WHERE role='org_admin'` query here returned every
  // org_admin across every tenant. The explicit filter makes the
  // tenant boundary load-bearing on the application code, not on
  // a deploy-time constant.
  if (filter.kind === "specific_user") {
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, filter.userId), eq(users.orgId, tenantId), isNull(users.deletedAt)))
      .limit(1);
    return rows.map((r: { id: string }) => r.id);
  }
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, tenantId), eq(users.role, "org_admin"), isNull(users.deletedAt)));
  return rows.map((r: { id: string }) => r.id);
}

interface ResolvedChannels {
  userId: string;
  /** Effective `in_app` decision — controls `panel_visible` on the row. */
  inApp: boolean;
  /** Effective `email_digest` decision — purely informational here; the
   *  digest worker reads `notification_preferences` itself. */
  emailDigest: boolean;
}

async function resolveChannels(
  // biome-ignore lint/suspicious/noExplicitAny: see above
  tx: any,
  userIds: string[],
  type: NotificationType,
  tenantId: string,
): Promise<ResolvedChannels[]> {
  if (userIds.length === 0) return [];
  // Pull preference rows for the (recipient set, type) pair only.
  // Earlier revisions scanned every preference row for the type
  // (scaling with tenant headcount); Data review H2 flagged the
  // scope mismatch. The new `inArray(userId, userIds)` clause hits
  // `notification_preferences_user_idx` directly. The explicit
  // `eq(orgId, tenantId)` is defence-in-depth (issue #430).
  const rows = await tx
    .select({
      userId: notificationPreferences.userId,
      inApp: notificationPreferences.inApp,
      emailDigest: notificationPreferences.emailDigest,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.orgId, tenantId),
        eq(notificationPreferences.type, type),
        inArray(notificationPreferences.userId, userIds),
      ),
    );

  const descriptor = getNotificationDescriptor(type);
  const defaultInApp = descriptor.defaultInApp;
  const defaultEmailDigest = descriptor.defaultEmailDigest;
  const explicit = new Map<string, { inApp: boolean; emailDigest: boolean }>();
  for (const row of rows as Array<{ userId: string; inApp: boolean; emailDigest: boolean }>) {
    explicit.set(row.userId, { inApp: row.inApp, emailDigest: row.emailDigest });
  }
  const resolved: ResolvedChannels[] = [];
  for (const id of userIds) {
    const explicitRow = explicit.get(id);
    const inApp = explicitRow?.inApp ?? defaultInApp;
    const emailDigest = explicitRow?.emailDigest ?? defaultEmailDigest;
    // Skip users who opted out of BOTH channels — no row needed.
    if (!inApp && !emailDigest) continue;
    resolved.push({ userId: id, inApp, emailDigest });
  }
  return resolved;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
