/**
 * Notification email digest worker (Epic #363, GLO-004 — Phase 5).
 *
 * Daily recurring BullMQ job. Scans every tenant + every user with
 * `notification_preferences.email_digest = true` and an unread row
 * since the last digest send, batches them into one email per user,
 * and sends via the existing `defaultEmailSender` plumbing.
 *
 * Opt-in by design: a user with no `notification_preferences` row
 * inherits the per-type registry default, which is `defaultEmailDigest:
 * false` for every type shipped in this Epic. The digest is therefore
 * silent on day one — operators have to actively toggle the channel
 * from the preferences page before any email is sent. This matches
 * `feedback_feature_flag_first` defence-in-depth posture.
 *
 * Out of scope (deferred):
 *   - Per-tenant DKIM / sending domain (depends on Epic #279) —
 *     today the digest goes from the platform-default `from` address.
 *   - HTML templating with the tenant logo — same dependency.
 *   - Unsubscribe link respecting the digest preference — current
 *     digest is opt-in, so an explicit unsubscribe just toggles the
 *     `email_digest` flag for every type via the preferences page.
 *   - Per-user locale resolution for the body. The shipped MVP
 *     renders English; a follow-up wires the same i18n templates the
 *     panel uses.
 *
 * Cadence: daily at 09:00 UTC (07:00 Paris winter, 08:00 Paris
 * summer) — early enough that an operator's morning catch-up email
 * is the first thing they see, late enough that an overnight donation
 * burst (gala-night fundraisers) is fully captured.
 */

import {
  getNotificationDescriptor,
  isNotificationType,
  type NotificationType,
} from "@givernance/shared/constants";
import { notificationPreferences, notifications, tenants, users } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { env } from "../env.js";
import { db, withWorkerContext } from "../lib/db.js";
import { defaultEmailSender, type EmailSender } from "../lib/email.js";
import { jobLogger } from "../lib/logger.js";

/** Per-tenant work budget — Worker SRE MED-1. A pathological tenant
 *  must not stall the whole tick. */
const PER_TENANT_TIMEOUT_MS = 30_000;
/** Hard ceiling on the `since` cursor so an operator-crafted job
 *  can't replay an unbounded window (Worker SRE LOW-2). */
const MAX_SINCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface EmailDigestJobData {
  /** ISO timestamp — the "since" cursor. Defaults to 24h ago. */
  since?: string;
}

export interface EmailDigestDeps {
  sender?: EmailSender;
}

/**
 * Process one tick of the daily digest. Iterates active tenants and,
 * for each, collects unread rows since the cursor and sends one digest
 * per recipient.
 */
export async function processNotificationsEmailDigest(
  job: Job<EmailDigestJobData>,
  deps: EmailDigestDeps = {},
): Promise<void> {
  const log = jobLogger({ jobId: job.id });
  const sender = deps.sender ?? defaultEmailSender;

  // Default cursor: 24h ago. If the caller passes an older value
  // we clamp to MAX_SINCE_WINDOW_MS so a hand-enqueued job can't
  // replay an unbounded history. The shipped MVP can lose a row in
  // the (rare) case of an SMTP failure followed by 24h+ of silence
  // — Worker SRE HIGH-4 calls out the correct fix: track
  // `tenants.last_digest_sent_at` instead of a fixed-window cursor.
  // Filed as a follow-up; the existing schema change is bigger than
  // this PR's footprint.
  const earliest = Date.now() - MAX_SINCE_WINDOW_MS;
  const requested = job.data.since
    ? new Date(job.data.since).getTime()
    : Date.now() - 24 * 60 * 60 * 1000;
  const since = new Date(Math.max(requested, earliest));

  // List every active tenant — owner-pool query, no RLS context.
  // Tenants don't soft-delete via `deleted_at`; they carry a `status`
  // varchar (`active|provisional|suspended|archived`). We send
  // digests only for `active`/`provisional` tenants — a paused or
  // archived customer shouldn't see digest mail from us. The table
  // is small (one row per NPO) so a full scan is fine; a follow-up
  // adds an index-only scan keyed by `tenants.last_digest_sent_at`.
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.status, ["active", "provisional"]));

  for (const tenant of tenantRows) {
    try {
      const sent = await Promise.race([
        processDigestForTenant(tenant.id, since, sender, log),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Per-tenant digest timeout after ${PER_TENANT_TIMEOUT_MS} ms`)),
            PER_TENANT_TIMEOUT_MS,
          ),
        ),
      ]);
      if (sent > 0) {
        log.info({ tenantId: tenant.id, sent }, "Sent notification digest");
      }
    } catch (err) {
      log.warn({ err, tenantId: tenant.id }, "Tenant digest failed — continuing");
    }
  }
}

async function processDigestForTenant(
  tenantId: string,
  since: Date,
  sender: EmailSender,
  log: ReturnType<typeof jobLogger>,
): Promise<number> {
  return withWorkerContext(tenantId, async (tx) => {
    // Users in this tenant who have opted into email digest for at
    // least one type AND have unread notifications since the cursor.
    const candidates = await tx
      .select({
        userId: notifications.userId,
        email: users.email,
        type: notifications.type,
        params: notifications.params,
        createdAt: notifications.createdAt,
        titleKey: notifications.titleKey,
        bodyKey: notifications.bodyKey,
        linkUrl: notifications.linkUrl,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(
        and(
          // Defence in depth (issue #430): every tenant-scoped query
          // filters by `org_id` explicitly. The GUC pin + RLS is the
          // safety net, not the contract.
          eq(notifications.orgId, tenantId),
          eq(users.orgId, tenantId),
          isNotNull(notifications.userId),
          isNull(notifications.readAt),
          isNull(notifications.deletedAt),
          isNull(users.deletedAt),
          gt(notifications.createdAt, since),
          // Has at least one preferences row with email_digest=true
          // for this notification's type. Subselect avoids a join blowup.
          sql`EXISTS (
            SELECT 1 FROM ${notificationPreferences} p
            WHERE p.user_id = ${notifications.userId}
              AND p.org_id = ${tenantId}::uuid
              AND p.type = ${notifications.type}
              AND p.email_digest = TRUE
          )`,
        ),
      );

    if (candidates.length === 0) return 0;

    // Group by recipient.
    const byUser = new Map<string, typeof candidates>();
    for (const row of candidates) {
      if (!row.userId) continue;
      const bucket = byUser.get(row.userId) ?? [];
      bucket.push(row);
      byUser.set(row.userId, bucket);
    }

    let sentCount = 0;
    for (const [userId, rows] of byUser) {
      const first = rows[0];
      if (!first) continue;
      try {
        const subject = `Givernance digest — ${rows.length} new notification${rows.length === 1 ? "" : "s"}`;
        const text = renderDigestText(rows);
        const html = renderDigestHtml(rows);
        await sender.send({ to: first.email, subject, text, html });
        sentCount++;
      } catch (err) {
        log.warn({ err, tenantId, userId }, "Digest send failed for user");
      }
    }
    return sentCount;
  });
}

interface DigestRow {
  type: string;
  titleKey: string;
  bodyKey: string;
  params: unknown;
  linkUrl: string | null;
  createdAt: Date;
}

/**
 * Defence-in-depth — the DB CHECK on `link_url` already rejects
 * protocol-relative paths (`//evil.example`) post-Security H1 fix,
 * but historical rows written before the CHECK was tightened may
 * still exist. Strip any `linkUrl` that doesn't pass the safe-path
 * shape before interpolating into a mailable href.
 */
function safeRelativePath(linkUrl: string | null): string | null {
  if (!linkUrl) return null;
  if (!linkUrl.startsWith("/")) return null;
  if (linkUrl.startsWith("//")) return null;
  if (linkUrl.startsWith("/\\")) return null;
  return linkUrl;
}

/**
 * Resolve a stored relative path (`/donations/<uuid>`) into the
 * absolute URL an email client can dereference. Stored relative paths
 * are correct for the panel (the browser already knows the origin) but
 * an email client renders the href against its OWN base — Mailpit's
 * `http://localhost:8025` in dev — and ends up on a 404. `APP_URL`
 * carries the tenant-facing origin (`http://localhost:3000` for dev,
 * `https://app.givernance.com` for SaaS prod).
 */
function absoluteUrl(relativePath: string): string {
  const base = env.APP_URL.replace(/\/+$/, "");
  return `${base}${relativePath}`;
}

function renderDigestText(rows: DigestRow[]): string {
  const lines = rows.map((row) => {
    const title = humanTitleFor(row.type);
    const when = row.createdAt.toISOString();
    const safeLink = safeRelativePath(row.linkUrl);
    const link = safeLink ? ` (${absoluteUrl(safeLink)})` : "";
    return `• ${title} — ${when}${link}`;
  });
  const preferencesUrl = absoluteUrl("/profile/notifications");
  return [
    "Here is your daily digest of in-app notifications from Givernance.",
    "",
    ...lines,
    "",
    `Manage your preferences at ${preferencesUrl}.`,
  ].join("\n");
}

function renderDigestHtml(rows: DigestRow[]): string {
  const items = rows
    .map((row) => {
      const title = escapeHtml(humanTitleFor(row.type));
      const when = escapeHtml(row.createdAt.toISOString());
      const safeLink = safeRelativePath(row.linkUrl);
      const link = safeLink ? `<a href="${escapeAttribute(absoluteUrl(safeLink))}">View</a>` : "";
      return `<li><strong>${title}</strong> — ${when} ${link}</li>`;
    })
    .join("");
  const preferencesUrl = escapeAttribute(absoluteUrl("/profile/notifications"));
  return `<!doctype html><html><body>
  <p>Here is your daily digest of in-app notifications from Givernance.</p>
  <ul>${items}</ul>
  <p>Manage your preferences at <a href="${preferencesUrl}">${preferencesUrl}</a>.</p>
  </body></html>`;
}

function humanTitleFor(type: string): string {
  if (!isNotificationType(type)) return type;
  const descriptor = getNotificationDescriptor(type as NotificationType);
  // We don't have a per-user locale resolved here; fall back to the
  // English title slug derived from the i18n key. A follow-up wires the
  // same translator the panel uses.
  return descriptor.titleKey.split(".").slice(-2, -1)[0] ?? type;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
