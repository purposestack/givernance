/**
 * Postal-export processor (Epic #274).
 *
 * Generates the bundled ZIP archive for a postal-export job. The HTTP path
 * has already inserted a `campaign_postal_exports` row in `pending`; this
 * processor:
 *
 *   1. Flips the row to `processing`.
 *   2. For each linked constituent (or once for door-drop), renders a PDF,
 *      registers a fresh QR token in `campaign_qr_codes`, and pipes the
 *      buffer into the running `archiver`.
 *   3. Ticks `progress_count` after each PDF so the UI's polling progress
 *      bar moves in real time.
 *   4. Streams the finalised archive into S3 via multipart upload.
 *   5. Marks the row `completed` with `zip_s3_path` populated, or `failed`
 *      with the captured error message.
 *
 * Failure modes:
 *   - A single-PDF render error fails the whole job (we don't ship a
 *     half-bundled archive). BullMQ retries the job up to 3× on transient
 *     errors; persistent failures land in the failed set.
 *   - If S3 upload fails after all PDFs streamed, the row is marked
 *     `failed`; the admin can re-trigger from the UI without DB residue.
 */

import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { GeneratePostalExportJob } from "@givernance/shared/jobs";
import {
  campaignConstituents,
  campaignPostalExports,
  campaignPublicPages,
  campaignQrCodes,
  campaigns,
  constituents,
} from "@givernance/shared/schema";
import archiver from "archiver";
import type { Job } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../env.js";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { uploadCampaignZip } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import { createCampaignLetterPdfStream } from "../services/campaign-pdf.js";

/**
 * Token generator — same shape as `campaign-documents.ts`'s. Kept local so
 * the two processors can evolve their security posture independently
 * (e.g. future move to a HMAC-derived token without touching the bulk-
 * documents path).
 */
function generateQrToken(): string {
  return randomBytes(15).toString("base64url");
}

/** Render one PDF to a Buffer (so we can pipe it into archiver synchronously). */
async function renderPdfBuffer(args: {
  campaignName: string;
  qrCode: string;
  recipient: { firstName: string; lastName: string; email: string | null } | null;
}): Promise<Buffer> {
  const stream = await createCampaignLetterPdfStream({
    campaignName: args.campaignName,
    orgId: "n/a",
    qrCode: args.qrCode,
    constituent: args.recipient,
  });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Sanitize a name so it's safe to use as a path component inside the ZIP. */
function sanitiseFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "letter";
}

export async function processGeneratePostalExport(
  job: Job<GeneratePostalExportJob["data"] & { traceparent?: string }>,
): Promise<{ uploaded: number }> {
  const { exportId, campaignId, orgId, mode, traceparent } = job.data;
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  log.info({ exportId, campaignId, mode }, "Postal export job start");

  // ── 1. Flip status to `processing`. ──────────────────────────────
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(campaignPostalExports)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(campaignPostalExports.id, exportId),
          eq(campaignPostalExports.orgId, orgId),
          eq(campaignPostalExports.campaignId, campaignId),
        ),
      );
  });

  // ── 2. Load campaign + (optionally) the linked constituents. ────
  const { campaign, recipients, publicPageUrl } = await withWorkerContext(orgId, async (tx) => {
    const [campaignRow] = await tx
      .select({ id: campaigns.id, name: campaigns.name, type: campaigns.type })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaignRow) {
      throw new Error(`Campaign ${campaignId} not found for org ${orgId}`);
    }

    const recipientRows =
      mode === "personalized"
        ? await tx
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
                isNull(constituents.deletedAt),
              ),
            )
        : [];

    // Public-page URL drives the QR redirect target. The opaque token is
    // appended as a query param at scan-time by the Givernance public site;
    // here we just compose the canonical `/c/:campaignId` link.
    const [_publicPage] = await tx
      .select({ id: campaignPublicPages.id })
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId));

    return {
      campaign: campaignRow,
      recipients: recipientRows,
      // The public donation page lives under `/p/:id` (see
      // `packages/web/src/app/(public)/p/[id]/page.tsx`). An earlier draft
      // of this code targeted `/c/:id`, which 404s — the QR codes printed
      // from such a build dropped donors on a "Page not found" screen.
      publicPageUrl: `${env.APP_URL}/p/${campaignId}`,
    };
  });

  // Pre-compute the work list so the ZIP order matches the DB order; the
  // QR tokens are minted now and inserted with their PDFs in step 3.
  type WorkItem = {
    qrToken: string;
    constituentId: string | null;
    fileName: string;
    recipient: { firstName: string; lastName: string; email: string | null } | null;
  };

  const workItems: WorkItem[] =
    mode === "personalized"
      ? recipients.map((r) => ({
          qrToken: generateQrToken(),
          constituentId: r.id,
          fileName: `${sanitiseFilename(`${r.lastName}-${r.firstName}`)}.pdf`,
          recipient: { firstName: r.firstName, lastName: r.lastName, email: r.email },
        }))
      : [
          {
            qrToken: generateQrToken(),
            constituentId: null,
            fileName: "door-drop.pdf",
            recipient: null,
          },
        ];

  if (workItems.length === 0) {
    // Defensive: API rejects this case, but if a stale job queued before
    // membership got purged we should fail fast rather than upload empty ZIP.
    await markFailed(orgId, exportId, "No recipients available for export");
    throw new Error("Postal export has zero recipients");
  }

  // ── 3. Stream archive to S3 and append PDFs concurrently with upload. ──
  // We use a PassThrough so `archiver`'s output starts uploading to S3
  // immediately; `archiver.finalize()` triggers the multipart completion.
  const passthrough = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("warning", (err) => log.warn({ err: err.message }, "archiver warning"));
  archive.pipe(passthrough);

  const uploadPromise = uploadCampaignZip(orgId, campaignId, exportId, passthrough);

  // Run the per-recipient loop sequentially. PDFKit's renderer is synchronous-
  // ish; concurrency would complicate progress accounting and the volume per
  // export (≤ a few thousand) is well within sequential reach.
  let uploaded = 0;
  try {
    for (const item of workItems) {
      // Mint the QR row first so a crash mid-loop leaves a stable audit
      // (the printed PDF and the DB token agree).
      await withWorkerContext(orgId, async (tx) => {
        await tx.insert(campaignQrCodes).values({
          orgId,
          campaignId,
          constituentId: item.constituentId,
          code: item.qrToken,
        });
      });

      const buffer = await renderPdfBuffer({
        campaignName: campaign.name,
        qrCode: `${publicPageUrl}?qr=${encodeURIComponent(item.qrToken)}`,
        recipient: item.recipient,
      });

      archive.append(buffer, { name: item.fileName });
      uploaded += 1;

      // Tick progress after each PDF lands in the archive — the polling
      // UI sees real-time movement.
      await withWorkerContext(orgId, async (tx) => {
        await tx
          .update(campaignPostalExports)
          .set({ progressCount: uploaded, updatedAt: new Date() })
          .where(
            and(eq(campaignPostalExports.id, exportId), eq(campaignPostalExports.orgId, orgId)),
          );
      });
    }

    await archive.finalize();
    const zipS3Path = await uploadPromise;

    await withWorkerContext(orgId, async (tx) => {
      await tx
        .update(campaignPostalExports)
        .set({
          status: "completed",
          zipS3Path,
          progressCount: uploaded,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(campaignPostalExports.id, exportId), eq(campaignPostalExports.orgId, orgId)));
    });

    log.info({ exportId, uploaded, zipS3Path }, "Postal export completed");
    return { uploaded };
  } catch (err) {
    archive.abort();
    passthrough.destroy(err instanceof Error ? err : new Error(String(err)));
    // Best-effort cancel of the in-flight multipart upload — the SDK's
    // `Upload` resolves rejected on body destroy, so awaiting it surfaces
    // the original error rather than masking with the abort.
    await uploadPromise.catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(orgId, exportId, message);
    log.error({ exportId, err: message }, "Postal export failed");
    throw err;
  }
}

async function markFailed(orgId: string, exportId: string, error: string) {
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(campaignPostalExports)
      .set({
        status: "failed",
        error,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(campaignPostalExports.id, exportId), eq(campaignPostalExports.orgId, orgId)));
  });
}
