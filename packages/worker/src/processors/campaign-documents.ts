/** Job processor — generate campaign document PDFs with QR codes */

import { randomBytes } from "node:crypto";
import type { GenerateCampaignDocumentsJob } from "@givernance/shared/jobs";
import {
  campaignDocuments,
  campaignQrCodes,
  campaigns,
  constituents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { uploadCampaignPdf } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import { createCampaignLetterPdfStream } from "../services/campaign-pdf.js";

/**
 * PDF fan-out concurrency. Each PDF streams through PDFKit → S3 multipart
 * upload, so the bottleneck is upload throughput, not CPU. 8 gives us a ~6×
 * speedup on 10k-recipient campaigns without triggering Scaleway's per-
 * connection throttling. Tune via `CAMPAIGN_PDF_CONCURRENCY` if needed.
 */
const CAMPAIGN_PDF_CONCURRENCY = Number(process.env.CAMPAIGN_PDF_CONCURRENCY ?? 8);

/**
 * Minimal semaphore — avoids pulling in `p-limit` (which ships ESM-only in
 * its current release and would force a dual-package dance with the existing
 * CJS-friendly build). Same semantics: caller wraps `sem(task)`, only N run
 * at a time, everything returns a flat Promise.
 */
function semaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const queue: Array<() => void> = [];
  let active = 0;

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tick = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            const next = queue.shift();
            if (next) next();
          });
      };
      if (active < limit) {
        tick();
      } else {
        queue.push(tick);
      }
    });
  };
}

/**
 * Generate an opaque, URL-safe QR code token.
 *
 * 15 random bytes → 20 base64url chars ≈ 120 bits of entropy. Collisions under
 * a `UNIQUE(org_id, code)` constraint are astronomically unlikely even across
 * millions of codes per tenant. We deliberately do NOT encode `orgId`,
 * `campaignId`, or `constituentId` — a scanned printed letter reveals nothing
 * about the recipient; resolution happens server-side (issue #56 Security #4).
 */
function generateQrToken(): string {
  return randomBytes(15).toString("base64url");
}

type Tx = Parameters<Parameters<typeof withWorkerContext>[1]>[0];

/** Generate a single nominative document for one constituent within a campaign */
async function generateConstituentDocument(
  tx: Tx,
  orgId: string,
  campaignId: string,
  campaignName: string,
  constituent: { id: string; firstName: string; lastName: string; email: string | null },
): Promise<string> {
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

  const [pendingDoc] = await tx
    .select()
    .from(campaignDocuments)
    .where(
      and(
        eq(campaignDocuments.campaignId, campaignId),
        eq(campaignDocuments.constituentId, constituent.id),
        eq(campaignDocuments.orgId, orgId),
        eq(campaignDocuments.status, "pending"),
      ),
    );

  const docId = pendingDoc?.id ?? constituent.id;
  const s3Path = await uploadCampaignPdf(orgId, campaignId, docId, pdfStream);

  if (pendingDoc) {
    await tx
      .update(campaignDocuments)
      .set({ s3Path, status: "generated", updatedAt: new Date() })
      .where(and(eq(campaignDocuments.id, pendingDoc.id), eq(campaignDocuments.orgId, orgId)));
  }

  return s3Path;
}

/** Process campaign document generation for a batch of constituents (or one door_drop) */
export async function processGenerateCampaignDocuments(
  job: Job<GenerateCampaignDocumentsJob["data"] & { traceparent?: string }>,
) {
  const { campaignId, orgId, constituentIds, traceparent } = job.data;

  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  log.info({ campaignId, constituentCount: constituentIds.length }, "Campaign documents job start");
  job.log(`Generating campaign documents for campaign ${campaignId} (org: ${orgId})`);

  return withWorkerContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found for org ${orgId}`);
    }

    if (campaign.type === "door_drop") {
      const code = generateQrToken();

      await tx.insert(campaignQrCodes).values({
        orgId,
        campaignId,
        constituentId: null,
        code,
      });

      const pdfStream = await createCampaignLetterPdfStream({
        campaignName: campaign.name,
        orgId,
        qrCode: code,
        constituent: null,
      });

      const [pendingDoc] = await tx
        .select()
        .from(campaignDocuments)
        .where(
          and(
            eq(campaignDocuments.campaignId, campaignId),
            eq(campaignDocuments.orgId, orgId),
            eq(campaignDocuments.status, "pending"),
          ),
        );

      const docId = pendingDoc?.id ?? campaignId;
      const s3Path = await uploadCampaignPdf(orgId, campaignId, docId, pdfStream);

      if (pendingDoc) {
        await tx
          .update(campaignDocuments)
          .set({ s3Path, status: "generated", updatedAt: new Date() })
          .where(and(eq(campaignDocuments.id, pendingDoc.id), eq(campaignDocuments.orgId, orgId)));
      }

      log.info({ s3Path }, "Door-drop document generated");
      job.log(`Door-drop document generated and uploaded to ${s3Path}`);
      return { generated: 1 };
    }

    // Nominative / digital campaigns — fetch constituent data
    if (constituentIds.length === 0) {
      log.info({ campaignId }, "No constituents to process");
      return { generated: 0 };
    }

    const constituentRows = await tx
      .select({
        id: constituents.id,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
        email: constituents.email,
      })
      .from(constituents)
      .where(and(inArray(constituents.id, constituentIds), eq(constituents.orgId, orgId)));

    // Fan out PDF generation up to CAMPAIGN_PDF_CONCURRENCY at a time. Serial
    // `for` kept things predictable but meant 10k-recipient campaigns spent
    // most of their time blocked on S3 roundtrip (issue #56 Platform #5).
    const sem = semaphore(CAMPAIGN_PDF_CONCURRENCY);

    const results = await Promise.allSettled(
      constituentRows.map((constituent) =>
        sem(async () => {
          const s3Path = await generateConstituentDocument(
            tx,
            orgId,
            campaignId,
            campaign.name,
            constituent,
          );
          log.debug({ constituentId: constituent.id, s3Path }, "Document generated");
          return s3Path;
        }),
      ),
    );

    const generated = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - generated;

    // Surface per-constituent failures without aborting the whole campaign —
    // retrying the job will re-process pending docs (ON CONFLICT ... update
    // already handles idempotent reruns via the unique constraint).
    for (const [index, r] of results.entries()) {
      if (r.status === "rejected") {
        log.error(
          {
            constituentId: constituentRows[index]?.id,
            err: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
          "Failed to generate constituent document",
        );
      }
    }

    log.info({ campaignId, generated, failed }, "Campaign documents job complete");
    job.log(`Campaign ${campaignId}: ${generated} documents generated (${failed} failed)`);

    if (failed > 0) {
      throw new Error(`Campaign ${campaignId}: ${failed} document(s) failed — job will retry`);
    }

    return { generated };
  });
}
