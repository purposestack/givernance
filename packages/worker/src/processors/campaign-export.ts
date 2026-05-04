/**
 * Campaign export processor (Epic #274) — generates the missing per-recipient
 * PDFs, bundles them into a ZIP archive, uploads the archive to S3, and
 * progressively updates `campaign_export_jobs` so the frontend's progress
 * bar reflects real worker state.
 *
 * The job is idempotent at the constituent level: re-running on a partially
 * completed job re-uses any PDF already present (skipping the QR code +
 * upload) and only fans out generation for the missing ones.
 */

import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  campaignConstituents,
  campaignDocuments,
  campaignExportJobs,
  campaignQrCodes,
  campaigns,
  constituents,
} from "@givernance/shared/schema";
import archiver from "archiver";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { getCampaignPdfBody, uploadCampaignArchive, uploadCampaignPdf } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import { createCampaignLetterPdfStream } from "../services/campaign-pdf.js";

export interface ProcessCampaignExportData {
  exportJobId: string;
  campaignId: string;
  orgId: string;
  mode: "door_drop" | "nominative";
  traceparent?: string;
}

/** ~120 bits of entropy in 20 base64url chars — see campaign-documents.ts. */
function generateQrToken(): string {
  return randomBytes(15).toString("base64url");
}

type Tx = Parameters<Parameters<typeof withWorkerContext>[1]>[0];

async function ensurePdfForConstituent(
  tx: Tx,
  orgId: string,
  campaignId: string,
  campaignName: string,
  constituent: { id: string; firstName: string; lastName: string; email: string | null },
): Promise<string> {
  // Re-use an existing generated doc if present — keeps re-runs cheap and
  // preserves the original QR token (so any printed letters stay valid).
  const [existingDoc] = await tx
    .select()
    .from(campaignDocuments)
    .where(
      and(
        eq(campaignDocuments.orgId, orgId),
        eq(campaignDocuments.campaignId, campaignId),
        eq(campaignDocuments.constituentId, constituent.id),
        eq(campaignDocuments.status, "generated"),
      ),
    );
  if (existingDoc?.s3Path && existingDoc.s3Path !== "pending") {
    return existingDoc.s3Path;
  }

  const code = generateQrToken();
  await tx.insert(campaignQrCodes).values({
    orgId,
    campaignId,
    constituentId: constituent.id,
    code,
  });

  const pdfStream = await createCampaignLetterPdfStream({
    campaignName,
    orgId,
    qrCode: code,
    constituent: {
      firstName: constituent.firstName,
      lastName: constituent.lastName,
      email: constituent.email,
    },
  });

  // Reserve a campaign_documents row up front so the s3 key is deterministic
  // and the row is queryable while the worker is still running.
  let docId: string;
  const [pendingDoc] = await tx
    .select()
    .from(campaignDocuments)
    .where(
      and(
        eq(campaignDocuments.orgId, orgId),
        eq(campaignDocuments.campaignId, campaignId),
        eq(campaignDocuments.constituentId, constituent.id),
      ),
    );
  if (pendingDoc) {
    docId = pendingDoc.id;
  } else {
    const [inserted] = await tx
      .insert(campaignDocuments)
      .values({
        orgId,
        campaignId,
        constituentId: constituent.id,
        s3Path: "pending",
        status: "pending",
      })
      .returning({ id: campaignDocuments.id });
    if (!inserted) throw new Error("ensurePdfForConstituent: failed to insert document row");
    docId = inserted.id;
  }

  const s3Path = await uploadCampaignPdf(orgId, campaignId, docId, pdfStream);

  await tx
    .update(campaignDocuments)
    .set({ s3Path, status: "generated", updatedAt: new Date() })
    .where(and(eq(campaignDocuments.id, docId), eq(campaignDocuments.orgId, orgId)));

  return s3Path;
}

async function ensureDoorDropPdf(
  tx: Tx,
  orgId: string,
  campaignId: string,
  campaignName: string,
): Promise<string> {
  const [existingDoc] = await tx
    .select()
    .from(campaignDocuments)
    .where(
      and(
        eq(campaignDocuments.orgId, orgId),
        eq(campaignDocuments.campaignId, campaignId),
        eq(campaignDocuments.status, "generated"),
      ),
    );
  if (existingDoc?.s3Path && existingDoc.s3Path !== "pending") {
    return existingDoc.s3Path;
  }

  const code = generateQrToken();
  await tx.insert(campaignQrCodes).values({
    orgId,
    campaignId,
    constituentId: null,
    code,
  });

  const pdfStream = await createCampaignLetterPdfStream({
    campaignName,
    orgId,
    qrCode: code,
    constituent: null,
  });

  const [inserted] = await tx
    .insert(campaignDocuments)
    .values({
      orgId,
      campaignId,
      constituentId: null,
      s3Path: "pending",
      status: "pending",
    })
    .returning({ id: campaignDocuments.id });
  if (!inserted) throw new Error("ensureDoorDropPdf: failed to insert document row");

  const s3Path = await uploadCampaignPdf(orgId, campaignId, inserted.id, pdfStream);
  await tx
    .update(campaignDocuments)
    .set({ s3Path, status: "generated", updatedAt: new Date() })
    .where(and(eq(campaignDocuments.id, inserted.id), eq(campaignDocuments.orgId, orgId)));

  return s3Path;
}

async function bumpProgress(orgId: string, exportJobId: string, increment = 1) {
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(campaignExportJobs)
      .set({
        progressDone: sql`${campaignExportJobs.progressDone} + ${increment}`,
        updatedAt: new Date(),
      })
      .where(and(eq(campaignExportJobs.id, exportJobId), eq(campaignExportJobs.orgId, orgId)));
  });
}

async function markJobFailed(orgId: string, exportJobId: string, errorMessage: string) {
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(campaignExportJobs)
      .set({
        status: "failed",
        error: errorMessage.slice(0, 2000),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(campaignExportJobs.id, exportJobId), eq(campaignExportJobs.orgId, orgId)));
  });
}

/**
 * Top-level processor for `generate-campaign-export` jobs. Fully resilient:
 * any thrown error is logged + persisted on `campaign_export_jobs.error`
 * so the front-end can render a meaningful failure state.
 */
export async function processGenerateCampaignExport(job: Job<ProcessCampaignExportData>) {
  const { exportJobId, campaignId, orgId, mode, traceparent } = job.data;

  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });
  log.info({ exportJobId, campaignId, mode }, "Campaign export job start");

  // 1. Mark the job as processing.
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(campaignExportJobs)
      .set({ status: "processing", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(campaignExportJobs.id, exportJobId), eq(campaignExportJobs.orgId, orgId)));
  });

  try {
    // 2. Generate per-recipient PDFs and remember their S3 keys for the ZIP step.
    const pdfTargets: Array<{ s3Path: string; filename: string }> = [];

    if (mode === "door_drop") {
      const s3Path = await withWorkerContext(orgId, async (tx) => {
        const [campaign] = await tx
          .select({ id: campaigns.id, name: campaigns.name })
          .from(campaigns)
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
        if (!campaign) {
          throw new Error(`Campaign ${campaignId} not found in org ${orgId}`);
        }
        return ensureDoorDropPdf(tx, orgId, campaignId, campaign.name);
      });
      pdfTargets.push({ s3Path, filename: "door-drop-letter.pdf" });
      await bumpProgress(orgId, exportJobId, 1);
    } else {
      // Snapshot the linked constituents.
      const linked = await withWorkerContext(orgId, async (tx) => {
        return tx
          .select({
            id: constituents.id,
            firstName: constituents.firstName,
            lastName: constituents.lastName,
            email: constituents.email,
          })
          .from(campaignConstituents)
          .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
          .where(
            and(
              eq(campaignConstituents.orgId, orgId),
              eq(campaignConstituents.campaignId, campaignId),
            ),
          );
      });

      if (linked.length === 0) {
        throw new Error("No constituents linked to this campaign at export time");
      }

      const [campaign] = await withWorkerContext(orgId, async (tx) =>
        tx
          .select({ id: campaigns.id, name: campaigns.name })
          .from(campaigns)
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId))),
      );
      if (!campaign) {
        throw new Error(`Campaign ${campaignId} not found in org ${orgId}`);
      }

      // Sequential generation keeps the per-PDF transaction short. If we hit
      // throughput issues here we can fan-out as the existing
      // `campaign-documents.ts` processor does — keeping it simple to start.
      for (const c of linked) {
        const s3Path = await withWorkerContext(orgId, async (tx) =>
          ensurePdfForConstituent(tx, orgId, campaignId, campaign.name, c),
        );
        const safeName = `${c.lastName}-${c.firstName}-${c.id.slice(0, 8)}`.replace(
          /[^a-zA-Z0-9_-]/g,
          "_",
        );
        pdfTargets.push({ s3Path, filename: `${safeName}.pdf` });
        await bumpProgress(orgId, exportJobId, 1);
      }
    }

    // 3. Stream the ZIP archive directly to S3 — never materialised in memory or on disk.
    const zip = archiver("zip", { zlib: { level: 9 } });
    const passthrough = new PassThrough();
    zip.pipe(passthrough);

    // Append all PDFs.
    for (const target of pdfTargets) {
      const body = await getCampaignPdfBody(target.s3Path);
      zip.append(body, { name: target.filename });
    }

    const finalize = zip.finalize();
    const archiveKey = await uploadCampaignArchive(orgId, campaignId, exportJobId, passthrough);
    await finalize;

    // 4. Mark the job as completed.
    await withWorkerContext(orgId, async (tx) => {
      await tx
        .update(campaignExportJobs)
        .set({
          status: "completed",
          archiveS3Path: archiveKey,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(campaignExportJobs.id, exportJobId), eq(campaignExportJobs.orgId, orgId)));
    });

    log.info({ exportJobId, archiveKey, count: pdfTargets.length }, "Campaign export complete");
    return { archiveKey, count: pdfTargets.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ exportJobId, err: message }, "Campaign export failed");
    await markJobFailed(orgId, exportJobId, message);
    // Re-throw so BullMQ can record the failure on the job itself; we do
    // NOT auto-retry inside the campaign queue (`attempts: 1` set below).
    throw err;
  }
}
