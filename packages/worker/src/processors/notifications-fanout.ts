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
 * Per-user opt-out is enforced at WRITE time: if a user has a
 * `notification_preferences` row with `in_app=false` for the type,
 * we skip the INSERT. Users without a row inherit the per-type
 * default from `NOTIFICATION_TYPE_REGISTRY`. Either way we never
 * write a row the user explicitly opted out of.
 *
 * Feature-flag-first: every call gates on
 * `communication.notifications_center` per `feedback_feature_flag_first`.
 * Defence in depth — even if a request slipped past the API gate the
 * worker is the second wall.
 *
 * Soft errors only — a fanout failure is logged but never thrown back
 * up. The existing routing decision (donation → receipt, branding →
 * activate, etc.) is the hard contract; notifications are best-effort
 * UX. A future Phase will move fanout to a dedicated queue with retry,
 * but until then we'd rather lose a notification row than fail to
 * generate a receipt PDF on the same event.
 */

import {
  FEATURE_FLAG_KEYS,
  getNotificationDescriptor,
  type NotificationType,
} from "@givernance/shared/constants";
import { BRANDING_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  type NewNotification,
  notificationPreferences,
  notifications,
  users,
} from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

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
export async function fanoutNotifications(input: FanoutInput): Promise<void> {
  const log = jobLogger({ tenantId: input.tenantId, jobId: input.outboxId });

  // Feature-flag-first per `feedback_feature_flag_first`. Cheap query,
  // run before any tenant-scoped DB work so the cost of a flagged-off
  // tenant is minimised.
  const enabled = await isFlagEnabled(FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER);
  if (!enabled) {
    log.debug({ eventType: input.type }, "Notifications flag off — skipping fanout");
    return;
  }

  const plan = planFanout(input);
  if (plan.length === 0) {
    return;
  }

  try {
    await withWorkerContext(input.tenantId, async (tx) => {
      for (const entry of plan) {
        const recipientUserIds = await resolveRecipients(tx, entry.recipients);
        if (recipientUserIds.length === 0) continue;

        // Honour per-user preferences. Users with `in_app=false` for
        // this type are silently dropped at write time so the worker
        // doesn't pile rows onto a user who opted out of the channel.
        const enabledRecipients = await filterByPreferences(tx, recipientUserIds, entry.type);
        if (enabledRecipients.length === 0) continue;

        const rows: NewNotification[] = enabledRecipients.map((userId) => ({
          orgId: input.tenantId,
          userId,
          type: entry.type,
          titleKey: entry.titleKey,
          bodyKey: entry.bodyKey,
          params: entry.params,
          linkUrl: entry.linkUrl,
        }));

        await tx.insert(notifications).values(rows);
      }
    });

    log.info({ eventType: input.type, planSize: plan.length }, "Notification fanout completed");
  } catch (err) {
    // Soft-fail — see file header. Notifications are UX, not contract.
    log.error(
      { err, eventType: input.type },
      "Notification fanout failed — continuing with existing routing",
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function resolveRecipients(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is awkward to spell out — same shape as in API service
  tx: any,
  filter: RecipientFilter,
): Promise<string[]> {
  if (filter.kind === "specific_user") {
    // RLS already isolates the tenant; we additionally filter
    // soft-deleted users.
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, filter.userId), isNull(users.deletedAt)))
      .limit(1);
    return rows.map((r: { id: string }) => r.id);
  }
  // all_org_admins — RLS isolates the tenant.
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "org_admin"), isNull(users.deletedAt)));
  return rows.map((r: { id: string }) => r.id);
}

async function filterByPreferences(
  // biome-ignore lint/suspicious/noExplicitAny: see above
  tx: any,
  userIds: string[],
  type: NotificationType,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  // Pull every preference row for these users + this type. A missing
  // row falls back to the per-type default in the registry.
  const rows = await tx
    .select({ userId: notificationPreferences.userId, inApp: notificationPreferences.inApp })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.type, type));

  const defaultInApp = getNotificationDescriptor(type).defaultInApp;
  const explicit = new Map<string, boolean>();
  for (const row of rows as Array<{ userId: string; inApp: boolean }>) {
    explicit.set(row.userId, row.inApp);
  }
  return userIds.filter((id) => {
    const v = explicit.get(id);
    return v === undefined ? defaultInApp : v;
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
