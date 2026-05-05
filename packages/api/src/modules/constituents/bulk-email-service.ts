/**
 * Bulk-email service (Epic #274).
 *
 * The HTTP path:
 *   1. Validates that every targeted constituent belongs to this org and has
 *      an email on file (skipped without one are reported back, not blocked).
 *   2. Inserts a `communication.bulk_email_requested` outbox event with the
 *      payload (subject + body + recipient list snapshot).
 *   3. Returns the dispatch counts so the UI can render
 *      "12 emails queued, 3 skipped — no address on file".
 *
 * The outbox relay forwards the event to the BullMQ `emails` queue, where
 * the `send-bulk-email` processor renders the template and dispatches each
 * email through the configured `EmailSender` (Mailpit in dev, Resend in
 * prod).
 *
 * Scope (MVP):
 *   - No template language. The admin types subject + plain-text body in
 *     the UI; we wrap it in a minimal HTML template for delivery.
 *   - No attachment support.
 *   - No scheduled send — dispatch is "send as soon as the worker picks it up".
 *   - No per-recipient personalization beyond the standard salutation.
 */

import { constituents, outboxEvents } from "@givernance/shared/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export class BulkEmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkEmailValidationError";
  }
}

export interface BulkEmailInput {
  /** Up to 500 ids per dispatch. The route enforces this; the service trusts the cap. */
  constituentIds: string[];
  subject: string;
  /**
   * Plain-text body — we add a minimal HTML wrapper at send time. Markdown
   * is intentionally NOT supported in MVP; that lands with the template
   * editor in a follow-up.
   */
  body: string;
}

export interface BulkEmailResult {
  /** Constituents enqueued for delivery (had an email on file). */
  queued: number;
  /** Constituents dropped because they had no email address. */
  skippedNoEmail: number;
}

export async function dispatchBulkEmail(
  orgId: string,
  userId: string,
  input: BulkEmailInput,
): Promise<BulkEmailResult> {
  const ids = Array.from(new Set(input.constituentIds.filter(Boolean)));
  if (ids.length === 0) {
    throw new BulkEmailValidationError("Provide at least one recipient");
  }

  return withTenantContext(orgId, async (tx) => {
    // Verify the requested ids belong to this org and are deliverable
    // (have an email). Read only the boolean we need — explicitly avoid
    // pulling email/firstName/lastName into the outbox payload so PII
    // is **not** persisted in `outbox_events.payload` (JSONB) nor pushed
    // through Redis as the BullMQ job payload (GDPR Art. 5(1)(e) storage
    // minimisation). The worker re-fetches contact details at send time
    // under its own RLS context.
    const rows = await tx
      .select({
        id: constituents.id,
        hasEmail: sql<boolean>`(${constituents.email} IS NOT NULL AND ${constituents.email} <> '')`,
      })
      .from(constituents)
      .where(
        and(
          inArray(constituents.id, ids),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      );

    if (rows.length !== ids.length) {
      throw new BulkEmailValidationError(
        "One or more recipients are not in this organization or have been deleted",
      );
    }

    const deliverableIds = rows.filter((r) => r.hasEmail).map((r) => r.id);
    const skippedNoEmail = rows.length - deliverableIds.length;

    if (deliverableIds.length === 0) {
      return { queued: 0, skippedNoEmail };
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "communication.bulk_email_requested",
      payload: {
        requestedBy: userId,
        subject: input.subject,
        body: input.body,
        // Ship only the id list — the worker re-resolves email + name at
        // send time. Keeps PII out of the outbox table and out of Redis.
        constituentIds: deliverableIds,
      },
    });

    return {
      queued: deliverableIds.length,
      skippedNoEmail,
    };
  });
}

/**
 * Read-only helper used by the route to short-circuit obvious "no recipients
 * have email" cases ahead of dispatch — the UI uses it to gray out the
 * Send button when the current selection has zero deliverable addresses.
 */
export async function countDeliverableRecipients(
  orgId: string,
  constituentIds: string[],
): Promise<number> {
  const ids = Array.from(new Set(constituentIds.filter(Boolean)));
  if (ids.length === 0) return 0;

  return withTenantContext(orgId, async (tx) => {
    const rows = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(
        and(
          inArray(constituents.id, ids),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
          isNotNull(constituents.email),
        ),
      );
    return rows.length;
  });
}
