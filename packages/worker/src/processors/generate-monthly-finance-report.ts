/**
 * Worker processor — generate the super-admin monthly finance report
 * PDF (issue #443).
 *
 * Input: `{ reportId, month, traceparent? }`. The API already wrote
 * the row with `status='pending'` and `kpi_snapshot` set; this
 * processor:
 *   1. Loads the row (under `systemDb` — platform-level table, no RLS).
 *   2. Renders the PDF from `kpi_snapshot`.
 *   3. Streams the PDF into `S3_REPORTS_BUCKET`.
 *   4. UPDATEs the row to `status='ready'` + `pdf_s3_key` + `ready_at`.
 *
 * Failure path: a thrown error sets `status='failed'` + `failure_reason`
 * before re-raising so BullMQ can apply its retry policy. The partial
 * unique index is scoped to `('pending','ready')` so a `failed` row
 * does not block a subsequent re-POST.
 */

import { platformFinanceReports } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
// `db` is the owner pool (BYPASSRLS) — appropriate for a platform-level
// table that has no `org_id` and explicitly REVOKEs grants from the
// app role.
import { db as systemDb } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { uploadPlatformReportPdf } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import {
  createPlatformReportPdfStream,
  type ReportSnapshot,
} from "../services/platform-report-pdf.js";

interface JobData {
  reportId: string;
  month: string;
  traceparent?: string;
}

export async function processGenerateMonthlyFinanceReport(job: Job<JobData>): Promise<void> {
  const { reportId, month, traceparent } = job.data;

  const log = jobLogger({
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });
  log.info({ reportId, month }, "Generating monthly platform finance report");
  job.log(`Generating monthly platform finance report ${reportId} (month=${month})`);

  const [row] = await systemDb
    .select()
    .from(platformFinanceReports)
    .where(eq(platformFinanceReports.id, reportId))
    .limit(1);

  if (!row) {
    throw new Error(`platform_finance_reports row ${reportId} not found`);
  }

  if (row.status === "ready") {
    log.info({ reportId }, "Report already ready — idempotent no-op");
    return;
  }

  if (!row.kpiSnapshot) {
    // The API always writes the snapshot before enqueueing; a missing
    // snapshot means the row was inserted by an out-of-band path (test
    // bypass, manual SQL) and the worker has nothing to render.
    await failRow(reportId, "kpi_snapshot is NULL — refusing to render an empty report");
    throw new Error(`platform_finance_reports.kpi_snapshot is NULL for ${reportId}`);
  }

  try {
    const snapshot = row.kpiSnapshot as ReportSnapshot;
    const generatedAt = new Date();
    const pdfStream = createPlatformReportPdfStream({
      reportId,
      month,
      snapshot,
      generatedAt,
    });

    const s3Key = await uploadPlatformReportPdf(month, reportId, pdfStream);

    await systemDb
      .update(platformFinanceReports)
      .set({
        status: "ready",
        pdfS3Key: s3Key,
        readyAt: generatedAt,
        // Clear any previous failure reason from an earlier attempt.
        failureReason: null,
      })
      .where(eq(platformFinanceReports.id, reportId));

    log.info({ reportId, month, s3Key }, "Monthly finance report ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRow(reportId, message);
    throw err;
  }
}

async function failRow(reportId: string, reason: string): Promise<void> {
  await systemDb
    .update(platformFinanceReports)
    .set({ status: "failed", failureReason: reason })
    .where(eq(platformFinanceReports.id, reportId));
}
