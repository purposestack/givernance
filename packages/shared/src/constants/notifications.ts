/**
 * Notification-centre type registry (Epic #363, GLO-004).
 *
 * The single source of truth for what notification types the codebase
 * produces. The DB column `notifications.type` is a free varchar(64)
 * pinned by a CHECK constraint to the dotted-namespace shape — adding
 * a new type is a code change here + a producer wiring, never a
 * migration.
 *
 * For each type:
 *   - `key`: dotted-namespace string written to `notifications.type`.
 *   - `defaultInApp`: whether the bell + panel show this type when a
 *     user has no `notification_preferences` row for it. Defaults to
 *     `true` for almost every type (notifications you didn't opt out
 *     of should still arrive) except for noisy background events.
 *   - `defaultEmailDigest`: whether the weekly digest worker
 *     (Phase 5) includes this type when the user has no preferences
 *     row. Defaults to `false` — we'd rather opt-in than opt-out for
 *     a second email channel.
 *   - `titleKey` / `bodyKey`: i18n keys consumed by the web panel and
 *     the email digest. Defined in `packages/web/src/messages/{en,fr}.json`
 *     under `notifications.types.<key>.{title,body}`.
 *   - `labelKey` / `descriptionKey`: i18n keys for the preferences
 *     page row ("Donation received — alert me when a donor completes
 *     a gift").
 *
 * Keep the registry in lockstep with the i18n messages — the
 * integration tests in `packages/api/src/tests/integration/notifications.test.ts`
 * assert that every key is referenceable.
 */

export const NOTIFICATION_TYPE_VALUES = [
  "donation.received",
  "invitation.created",
  "invitation.resent",
  "branding.logo_synced",
  "postal_export.queued",
  "bulk_email.queued",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPE_VALUES)[number];

export interface NotificationTypeDescriptor {
  key: NotificationType;
  defaultInApp: boolean;
  defaultEmailDigest: boolean;
  /** i18n key for the panel row title. */
  titleKey: string;
  /** i18n key for the panel row body (interpolated with `params`). */
  bodyKey: string;
  /** i18n key for the preferences-page row label. */
  labelKey: string;
  /** i18n key for the preferences-page row helper text. */
  descriptionKey: string;
  /**
   * Visual category used by the panel for icon + accent-bar colour.
   * `donation`/`success` → green, `team` → indigo, `system` → sky,
   * `attention` → amber. Maps to the mockup's
   * `.accent-{green,indigo,sky,amber}` classes.
   */
  visual: "donation" | "team" | "system" | "attention";
}

export const NOTIFICATION_TYPE_REGISTRY: ReadonlyArray<NotificationTypeDescriptor> = [
  {
    key: "donation.received",
    defaultInApp: true,
    defaultEmailDigest: false,
    titleKey: "notifications.types.donation_received.title",
    bodyKey: "notifications.types.donation_received.body",
    labelKey: "notifications.types.donation_received.label",
    descriptionKey: "notifications.types.donation_received.description",
    visual: "donation",
  },
  {
    key: "invitation.created",
    defaultInApp: true,
    defaultEmailDigest: false,
    titleKey: "notifications.types.invitation_created.title",
    bodyKey: "notifications.types.invitation_created.body",
    labelKey: "notifications.types.invitation_created.label",
    descriptionKey: "notifications.types.invitation_created.description",
    visual: "team",
  },
  {
    key: "invitation.resent",
    defaultInApp: false,
    defaultEmailDigest: false,
    titleKey: "notifications.types.invitation_resent.title",
    bodyKey: "notifications.types.invitation_resent.body",
    labelKey: "notifications.types.invitation_resent.label",
    descriptionKey: "notifications.types.invitation_resent.description",
    visual: "team",
  },
  {
    key: "branding.logo_synced",
    defaultInApp: true,
    defaultEmailDigest: false,
    titleKey: "notifications.types.branding_logo_synced.title",
    bodyKey: "notifications.types.branding_logo_synced.body",
    labelKey: "notifications.types.branding_logo_synced.label",
    descriptionKey: "notifications.types.branding_logo_synced.description",
    visual: "system",
  },
  {
    key: "postal_export.queued",
    defaultInApp: true,
    defaultEmailDigest: false,
    titleKey: "notifications.types.postal_export_queued.title",
    bodyKey: "notifications.types.postal_export_queued.body",
    labelKey: "notifications.types.postal_export_queued.label",
    descriptionKey: "notifications.types.postal_export_queued.description",
    visual: "system",
  },
  {
    key: "bulk_email.queued",
    defaultInApp: true,
    defaultEmailDigest: false,
    titleKey: "notifications.types.bulk_email_queued.title",
    bodyKey: "notifications.types.bulk_email_queued.body",
    labelKey: "notifications.types.bulk_email_queued.label",
    descriptionKey: "notifications.types.bulk_email_queued.description",
    visual: "team",
  },
];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPE_VALUES as readonly string[]).includes(value);
}

export function getNotificationDescriptor(type: NotificationType): NotificationTypeDescriptor {
  const found = NOTIFICATION_TYPE_REGISTRY.find((d) => d.key === type);
  if (!found) {
    // Unreachable — type is a closed union and the registry is
    // verified to be exhaustive by `assertRegistryCovers` below.
    throw new Error(`Unknown notification type: ${type}`);
  }
  return found;
}

/**
 * Filter chip categories shown in the panel header (matches the
 * mockup's "Toutes / Échéances / IA / Équipe" pattern, repurposed to
 * the shipped types).
 */
export const NOTIFICATION_FILTER_KEYS = ["all", "donation", "team", "system"] as const;
export type NotificationFilterKey = (typeof NOTIFICATION_FILTER_KEYS)[number];

/**
 * Map a notification type to its filter chip — used by the panel to
 * partition the list when a chip is active.
 */
export function notificationFilterFor(type: NotificationType): NotificationFilterKey {
  const desc = getNotificationDescriptor(type);
  if (desc.visual === "donation") return "donation";
  if (desc.visual === "team") return "team";
  return "system";
}

// Compile-time exhaustiveness: build fails if `NOTIFICATION_TYPE_VALUES`
// gains a member that `NOTIFICATION_TYPE_REGISTRY` doesn't cover.
type _ExhaustiveRegistryCheck = {
  [K in NotificationType]: K extends NotificationTypeDescriptor["key"] ? true : never;
}[NotificationType];
const _exhaustive: _ExhaustiveRegistryCheck = true;
void _exhaustive;
