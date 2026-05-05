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
 * Idempotency (audit follow-up — Kamal pod crash mid-export):
 *   - QR codes are inserted with the `export_id` of this job and a partial
 *     unique index on `(export_id, COALESCE(constituent_id, sentinel))`.
 *     On retry we SELECT the previously-minted rows and reuse their tokens
 *     instead of generating new ones, so a crash partway through doesn't
 *     leave behind stranded QR codes that no printed letter references.
 *   - The S3 ZIP key is deterministic (`{org}/campaigns/{cid}/exports/{eid}.zip`),
 *     so a retry overwrites the previous (incomplete) upload.
 *   - The progress_count update is idempotent — last-write-wins on the
 *     same row, never decremented.
 *   - The terminal `completed` flip is gated on the row not already being
 *     `completed` so a double-finish doesn't clobber `completed_at`.
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
  tenants,
} from "@givernance/shared/schema";
import archiver from "archiver";
import type { Job } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
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
  organisationName: string;
  organisationMission: string | null;
  campaignName: string;
  campaignDescription: string | null;
  qrCode: string;
  qrReference: string;
  recipient: {
    firstName: string;
    lastName: string;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    countryCode: string | null;
  } | null;
}): Promise<Buffer> {
  const stream = await createCampaignLetterPdfStream({
    organisationName: args.organisationName,
    organisationMission: args.organisationMission,
    campaignName: args.campaignName,
    campaignDescription: args.campaignDescription,
    qrPayload: args.qrCode,
    qrReference: args.qrReference,
    recipient: args.recipient,
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

  log.info(
    { exportId, campaignId, mode, attempt: job.attemptsMade ?? 0 },
    "Postal export job start",
  );

  // ── 0. Short-circuit on already-completed exports. ───────────────
  // BullMQ may re-queue a job whose previous run flipped the row to
  // `completed` but failed to ack (rare — Redis crash between worker
  // commit and BullMQ status write). Re-running would re-mint nothing
  // (idempotent guards downstream) but would still upload a redundant
  // ZIP and emit a misleading "completed" log. Cheaper to early-exit.
  const [existing] = await withWorkerContext(orgId, async (tx) =>
    tx
      .select({
        status: campaignPostalExports.status,
        progressCount: campaignPostalExports.progressCount,
      })
      .from(campaignPostalExports)
      .where(and(eq(campaignPostalExports.id, exportId), eq(campaignPostalExports.orgId, orgId))),
  );
  if (existing?.status === "completed") {
    log.info({ exportId }, "Postal export already completed — skipping retry");
    return { uploaded: existing.progressCount };
  }

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

  // ── 2. Load campaign + tenant identity + (optionally) the linked constituents. ────
  const { campaign, tenant, recipients, publicPageUrl } = await withWorkerContext(
    orgId,
    async (tx) => {
      const [campaignRow] = await tx
        .select({
          id: campaigns.id,
          name: campaigns.name,
          description: campaigns.description,
          type: campaigns.type,
        })
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

      if (!campaignRow) {
        throw new Error(`Campaign ${campaignId} not found for org ${orgId}`);
      }

      // Operator's organisation — name + mission drive the letterhead and
      // the contextual paragraph. RLS lets the app role read its own
      // tenant row by `id = app_current_organization_id()`.
      const [tenantRow] = await tx
        .select({ name: tenants.name, mission: tenants.mission })
        .from(tenants)
        .where(eq(tenants.id, orgId));

      const recipientRows =
        mode === "personalized"
          ? await tx
              .select({
                id: constituents.id,
                firstName: constituents.firstName,
                lastName: constituents.lastName,
                email: constituents.email,
                addressLine1: constituents.addressLine1,
                addressLine2: constituents.addressLine2,
                postalCode: constituents.postalCode,
                city: constituents.city,
                countryCode: constituents.countryCode,
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
      // appended at scan-time so the worker just composes the canonical
      // `/p/:campaignId` link.
      const [_publicPage] = await tx
        .select({ id: campaignPublicPages.id })
        .from(campaignPublicPages)
        .where(eq(campaignPublicPages.campaignId, campaignId));

      return {
        campaign: campaignRow,
        tenant: tenantRow ?? { name: "Your organisation", mission: null },
        recipients: recipientRows,
        // The public donation page lives under `/p/:id` (see
        // `packages/web/src/app/(public)/p/[id]/page.tsx`). An earlier draft
        // of this code targeted `/c/:id`, which 404s — the QR codes printed
        // from such a build dropped donors on a "Page not found" screen.
        publicPageUrl: `${env.APP_URL}/p/${campaignId}`,
      };
    },
  );

  // ── 2b. Reuse QR codes from a prior crashed attempt. ─────────────
  // On retry, `campaign_qr_codes` may already hold rows that the previous
  // run inserted before crashing. We keyed those rows by `(export_id,
  // constituent_id)` (partial unique index — see migration 0040) so we
  // can pull them up here and reuse their tokens — guaranteeing one QR
  // per recipient regardless of retry count.
  const existingQrRows = await withWorkerContext(orgId, async (tx) =>
    tx
      .select({
        constituentId: campaignQrCodes.constituentId,
        code: campaignQrCodes.code,
      })
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, orgId), eq(campaignQrCodes.exportId, exportId))),
  );

  // Build a lookup: constituentId -> existing token. The door-drop case
  // (constituent_id IS NULL) is keyed under the symbolic `__door_drop__`
  // entry — there's at most one such row per export, enforced by the
  // partial unique index in migration 0040.
  const DOOR_DROP_KEY = "__door_drop__" as const;
  const existingTokenByRecipient = new Map<string, string>();
  for (const row of existingQrRows) {
    existingTokenByRecipient.set(row.constituentId ?? DOOR_DROP_KEY, row.code);
  }

  if (existingQrRows.length > 0) {
    log.info(
      { exportId, reusedCount: existingQrRows.length, attempt: job.attemptsMade ?? 0 },
      "Reusing QR codes from a previous attempt — idempotent retry",
    );
  }

  // Pre-compute the work list so the ZIP order matches the DB order; the
  // QR tokens are minted now and inserted with their PDFs in step 3. On
  // retry, prefer the previously-minted token over a freshly generated
  // one so the ZIP we ship matches the DB rows already on disk.
  type WorkItem = {
    qrToken: string;
    /** True when the token was loaded from a prior attempt and must NOT be re-inserted. */
    qrAlreadyPersisted: boolean;
    constituentId: string | null;
    fileName: string;
    recipient: {
      firstName: string;
      lastName: string;
      email: string | null;
      addressLine1: string | null;
      addressLine2: string | null;
      postalCode: string | null;
      city: string | null;
      countryCode: string | null;
    } | null;
  };

  function tokenFor(recipientKey: string): { token: string; alreadyPersisted: boolean } {
    const reuse = existingTokenByRecipient.get(recipientKey);
    if (reuse) return { token: reuse, alreadyPersisted: true };
    return { token: generateQrToken(), alreadyPersisted: false };
  }

  const workItems: WorkItem[] =
    mode === "personalized"
      ? recipients.map((r) => {
          const { token, alreadyPersisted } = tokenFor(r.id);
          return {
            qrToken: token,
            qrAlreadyPersisted: alreadyPersisted,
            constituentId: r.id,
            fileName: `${sanitiseFilename(`${r.lastName}-${r.firstName}`)}.pdf`,
            recipient: {
              firstName: r.firstName,
              lastName: r.lastName,
              email: r.email,
              addressLine1: r.addressLine1,
              addressLine2: r.addressLine2,
              postalCode: r.postalCode,
              city: r.city,
              countryCode: r.countryCode,
            },
          };
        })
      : (() => {
          const { token, alreadyPersisted } = tokenFor(DOOR_DROP_KEY);
          return [
            {
              qrToken: token,
              qrAlreadyPersisted: alreadyPersisted,
              constituentId: null,
              fileName: "door-drop.pdf",
              recipient: null,
            },
          ];
        })();

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
      // (the printed PDF and the DB token agree). Skip the insert on
      // retry when the row was already persisted by a prior attempt —
      // the partial unique index would also reject the duplicate, but
      // the explicit branch is cheaper and keeps the log-line clean.
      if (!item.qrAlreadyPersisted) {
        await withWorkerContext(orgId, async (tx) => {
          await tx.insert(campaignQrCodes).values({
            orgId,
            campaignId,
            constituentId: item.constituentId,
            code: item.qrToken,
            exportId,
          });
        });
      }

      const buffer = await renderPdfBuffer({
        organisationName: tenant.name,
        organisationMission: tenant.mission,
        campaignName: campaign.name,
        campaignDescription: campaign.description,
        qrCode: `${publicPageUrl}?qr=${encodeURIComponent(item.qrToken)}`,
        qrReference: item.qrToken,
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

    // Idempotent terminal flip: only set `completed_at` when we're
    // actually moving to `completed`. If a concurrent retry already
    // finished (rare — partial-failure race), keep the original
    // `completed_at` so audit trails stay stable.
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
        .where(
          and(
            eq(campaignPostalExports.id, exportId),
            eq(campaignPostalExports.orgId, orgId),
            sql`${campaignPostalExports.status} <> 'completed'`,
          ),
        );
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
