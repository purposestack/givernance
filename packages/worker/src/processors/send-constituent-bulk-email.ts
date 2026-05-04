/**
 * Constituent bulk email processor (Epic #274).
 *
 * Distinct from the legacy {@link processSendBulkEmail} (segment-filter
 * driven) — this one sends a free-form admin-authored email to a literal
 * id list captured at request time, mirroring the multi-select "Send
 * email" action on the constituents table.
 *
 * Sends are sequential by design (small admin batches, low throughput
 * needs). Per-recipient failures are logged but do NOT abort the run —
 * the user gets a "12/15 sent" outcome rather than a single bad address
 * killing the whole batch.
 */

import type { SendConstituentBulkEmailJob } from "@givernance/shared/jobs";
import { constituents } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { defaultEmailSender } from "../lib/email.js";
import { jobLogger } from "../lib/logger.js";

export async function processSendConstituentBulkEmail(
  job: Job<SendConstituentBulkEmailJob["data"] & { traceparent?: string }>,
) {
  const { orgId, requestedByUserId, constituentIds, subject, bodyText } = job.data;
  const log = jobLogger({ tenantId: orgId, jobId: job.id });

  log.info(
    { recipientCount: constituentIds.length, requestedByUserId },
    "Constituent bulk-email job start",
  );

  // Fetch the recipients within the tenant context — the route already
  // verified ownership, but RLS adds defense-in-depth here in case the
  // job runs after a constituent gets soft-deleted between request and
  // dispatch.
  const recipients = await withWorkerContext(orgId, async (tx) =>
    tx
      .select({
        id: constituents.id,
        email: constituents.email,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
      })
      .from(constituents)
      .where(
        and(
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
          inArray(constituents.id, constituentIds),
        ),
      ),
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  // Plain-text body is the source of truth; the HTML version is a minimal
  // wrapper so the recipient's mail client doesn't render a stark wall of
  // monospaced characters. We deliberately do NOT inject the recipient's
  // name into the message — the user can do that in the body if they want
  // it, and a templating layer is out of MVP scope (Epic #274).
  const html = `<div style="font-family: system-ui, sans-serif; line-height: 1.6;">${bodyText
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? "<br/>" : line))
    .join("<br/>")}</div>`;

  for (const recipient of recipients) {
    if (!recipient.email || recipient.email.trim().length === 0) {
      skipped++;
      continue;
    }
    try {
      await defaultEmailSender.send({
        to: recipient.email,
        subject,
        html,
        text: bodyText,
      });
      sent++;
    } catch (err) {
      failed++;
      log.error(
        {
          recipientId: recipient.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Constituent bulk-email recipient failed",
      );
    }
  }

  log.info({ sent, skipped, failed, totalRequested: recipients.length }, "Bulk email finished");
  return { sent, skipped, failed };
}
