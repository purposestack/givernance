/**
 * Bulk-email processor (Epic #274).
 *
 * Inputs: a `segmentFilter` carrying the rendered subject + body and the
 * pre-resolved recipient list snapshot (so the dispatch is deterministic
 * even if constituents are mutated between request and send). The list
 * comes from the API service, not from a fresh DB query — keeps Redis the
 * source of truth for "who got this email" once the job is in flight.
 *
 * Each recipient is sent in series via the configured `EmailSender`
 * (Mailpit in dev, Resend in prod). Per-recipient failures are logged
 * but do not fail the whole job — partial delivery beats no delivery for
 * an admin-triggered campaign.
 */

import type { SendBulkEmailJob } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { defaultEmailSender } from "../lib/email.js";
import { jobLogger } from "../lib/logger.js";

interface BulkEmailRecipient {
  constituentId: string;
  email: string;
  firstName: string;
  lastName: string;
}

interface BulkEmailSegmentFilter {
  subject?: string;
  body?: string;
  recipients?: BulkEmailRecipient[];
  requestedBy?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap the admin-supplied plain-text body in a minimal HTML shell. */
function renderHtml(subject: string, body: string, recipientName: string): string {
  const safeSubject = escapeHtml(subject);
  const greeting = recipientName ? `Hi ${escapeHtml(recipientName)},` : "Hello,";
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeSubject}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; color: #1f2937;">
    <div style="max-width: 560px; margin: 0 auto; padding: 24px;">
      <p>${greeting}</p>
      ${paragraphs}
      <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
      <p style="font-size: 12px; color: #6b7280;">
        Sent via Givernance.
      </p>
    </div>
  </body>
</html>`;
}

function renderText(body: string, recipientName: string): string {
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,";
  return `${greeting}\n\n${body}\n\n— Sent via Givernance.`;
}

export async function processSendBulkEmail(job: Job<SendBulkEmailJob["data"]>) {
  const data = job.data;
  const segment = (data.segmentFilter ?? {}) as BulkEmailSegmentFilter;
  const log = jobLogger({ tenantId: data.orgId, jobId: job.id });

  const subject = segment.subject ?? "Message from your nonprofit";
  const body = segment.body ?? "";
  const recipients = segment.recipients ?? [];

  if (recipients.length === 0) {
    log.warn({ orgId: data.orgId }, "Bulk email job had no recipients, no-op");
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    if (!recipient.email) {
      failed += 1;
      continue;
    }
    try {
      await defaultEmailSender.send({
        to: recipient.email,
        subject,
        html: renderHtml(subject, body, recipient.firstName),
        text: renderText(body, recipient.firstName),
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          constituentId: recipient.constituentId,
        },
        "Bulk email send failed for recipient",
      );
    }
  }

  log.info({ sent, failed, total: recipients.length }, "Bulk email job complete");
  return { sent, failed };
}
