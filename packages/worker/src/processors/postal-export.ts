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
import type { Locale } from "@givernance/shared/i18n";
import type { GeneratePostalExportJob } from "@givernance/shared/jobs";
import {
  type PostalExportRunMode,
  resolvePostalExportMode,
} from "@givernance/shared/postal-export-mode";
import { hasPageFromStatus } from "@givernance/shared/postal-print-layout";
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
import { getActivePdfLetterhead } from "../services/branding-logo-cache.js";
import {
  type CampaignLetterRecipient,
  createCampaignLetterPdfStream,
} from "../services/campaign-pdf.js";
import {
  ensureSwissQrReference,
  loadBankAccountForRender,
  qrBillFilenameFor,
  renderSwissQrBillPdf,
  resolveReferenceType,
  type SwissQrBillRenderContext,
} from "../services/swiss-qr-bill.js";

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
  /** Static-copy locale (`tenants.default_locale`). Defaults to `fr` in the renderer. */
  locale: Locale | null;
  /**
   * Active org logo bitmap (Epic #286). Null when the tenant has no
   * logo configured — the renderer skips the embed and the layout is
   * unchanged.
   */
  logoBuffer: Buffer | null;
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
    logoBuffer: args.logoBuffer,
    campaignName: args.campaignName,
    campaignDescription: args.campaignDescription,
    locale: args.locale,
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
        // Epic #318 PR #4 MAJOR-1 follow-up: read the stamped run mode
        // so we can assert downstream that the live inputs haven't
        // drifted since the operator enqueued. NULL = legacy row
        // (pre-migration 0045); we skip the drift assertion in that case.
        runMode: campaignPostalExports.runMode,
      })
      .from(campaignPostalExports)
      .where(and(eq(campaignPostalExports.id, exportId), eq(campaignPostalExports.orgId, orgId))),
  );
  if (existing?.status === "completed") {
    log.info({ exportId }, "Postal export already completed — skipping retry");
    return { uploaded: existing.progressCount };
  }
  // Stamped at API enqueue time; NULL means a pre-0045 legacy row.
  const stampedRunMode = existing?.runMode ?? null;

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
  const { campaign, tenant, recipients, publicPageStatus, publicPageUrl } = await withWorkerContext(
    orgId,
    async (tx) => {
      const [campaignRow] = await tx
        .select({
          id: campaigns.id,
          name: campaigns.name,
          description: campaigns.description,
          type: campaigns.type,
          // Epic #318 — Swiss QR-bill toggle. NULL = standard rail (no
          // QR-bill PDF appended); set = Swiss QR-bill mode active.
          bankAccountId: campaigns.bankAccountId,
          qrReferenceMode: campaigns.qrReferenceMode,
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
        .select({
          name: tenants.name,
          mission: tenants.mission,
          // Tenant default locale drives the static letter copy (Epic
          // #274 follow-up). Until campaigns carry their own locale, we
          // render every letter in the org's preferred language.
          defaultLocale: tenants.defaultLocale,
        })
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

      // Epic #318 PR #4 — load the public-page status so the worker can
      // re-resolve the export mode at runtime. Inputs (bank_account_id +
      // public_page.status) haven't changed since the API readiness gate
      // ran; we re-resolve here to avoid persisting the mode on the
      // export row (schema-frozen for PR #4).
      const [publicPage] = await tx
        .select({ status: campaignPublicPages.status })
        .from(campaignPublicPages)
        // Defence in depth (issue #430): explicit orgId filter so the
        // mode re-resolution cannot pick up a foreign tenant's
        // public-page status if the campaign_id ever collided.
        .where(
          and(eq(campaignPublicPages.campaignId, campaignId), eq(campaignPublicPages.orgId, orgId)),
        );

      return {
        campaign: campaignRow,
        tenant:
          tenantRow ??
          ({
            name: "Your organisation",
            mission: null,
            defaultLocale: "fr" as Locale,
          } satisfies { name: string; mission: string | null; defaultLocale: Locale }),
        recipients: recipientRows,
        publicPageStatus: publicPage?.status ?? null,
        // The public donation page lives under `/p/:id` (see
        // `packages/web/src/app/(public)/p/[id]/page.tsx`).
        publicPageUrl: `${env.APP_URL}/p/${campaignId}`,
      };
    },
  );

  // Epic #318 PR #4 — resolve the run mode. The 4-input truth table is in
  // `@givernance/shared/postal-export-mode`; the API readiness gate ran
  // the same check at job-enqueue time, so we should never hit `blocked`
  // here, but guarding defensively keeps the worker honest in face of a
  // race between API enqueue and worker pickup.
  const runMode: PostalExportRunMode = resolvePostalExportMode({
    hasBank: campaign.bankAccountId !== null,
    // `hasPage = page row exists` (status: draft OR published) — same
    // semantics as the API resolver. The publish-status gate already
    // fired at API time, so a non-`published` page here implies a race
    // we treat as blocked (worker fail-fast).
    hasPage: hasPageFromStatus(publicPageStatus),
  });
  if (runMode === "blocked") {
    throw new Error(
      `Postal export ${exportId} resolved to mode=blocked at worker time — neither bank account nor published public page available (probable race with operator unconfiguration)`,
    );
  }

  await assertNoRunModeDrift({ orgId, exportId, stampedRunMode, liveRunMode: runMode, log });
  log.info(
    { exportId, runMode, stampedRunMode },
    "Postal export mode resolved at worker (drift-assertion clean)",
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

  // ── Resolve the active logo once at the top of the run ─────────────
  // Epic #286 — every PDF in this export embeds the same logo, so we
  // fetch the `pdf-letterhead` variant exactly once and pass it down.
  // Cache hits are in-process; misses incur one S3 round-trip per
  // worker process per logo-asset-id.
  const logoBuffer = await getActivePdfLetterhead(orgId);
  if (logoBuffer) {
    log.info({ exportId, logoBytes: logoBuffer.byteLength }, "Embedding org logo in postal PDFs");
  }

  // ── Epic #318 — resolve Swiss QR-bill context once. ─────────────────
  // Campaigns without a linked `bank_account_id` skip this branch and
  // keep producing the standard single-PDF-per-letter ZIP (back-compat
  // is total). When linked, every work item also produces an adjacent
  // `{recipient}-qr-bill.pdf` carrying a per-recipient (personalised)
  // or per-export (door-drop) QRR/SCOR reference.
  const swissQrCtx = await loadSwissQrCtxIfActive({
    orgId,
    exportId,
    bankAccountId: campaign.bankAccountId,
    qrReferenceMode: campaign.qrReferenceMode,
    campaignName: campaign.name,
    log,
  });

  // Re-snapshot total_count to the live work-item count. The API stamps
  // a request-time snapshot, but a constituent added/removed between the
  // API call and the worker run would otherwise produce a UI bar like
  // "10/9 done" (progressCount > totalCount). Using the worker's own
  // count keeps the denominator authoritative for the actual run.
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(campaignPostalExports)
      .set({ totalCount: workItems.length, updatedAt: new Date() })
      .where(and(eq(campaignPostalExports.id, exportId), eq(campaignPostalExports.orgId, orgId)));
  });

  // ── 3. Stream archive to S3 and append PDFs concurrently with upload. ──
  // We use a PassThrough so `archiver`'s output starts uploading to S3
  // immediately; `archiver.finalize()` triggers the multipart completion.
  const passthrough = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("warning", (err) => log.warn({ err: err.message }, "archiver warning"));
  // `archiver` emits 'error' on internal failures (invalid entry, zlib
  // stream errors, etc.). Without an 'error' listener Node's
  // EventEmitter would re-throw, crashing the worker process. The
  // surrounding try/catch only catches Promise rejections — EventEmitter
  // errors are not awaitable. Forward the error to the upload stream so
  // the multipart upload aborts cleanly and the catch block below runs.
  archive.on("error", (err) => {
    log.error({ err: err.message }, "archiver error");
    passthrough.destroy(err);
  });
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

      // Epic #318 PR #4 — mode-aware PDF emission per work item.
      //   standard     → 1 PDF: appeal letter with scan-QR (today's default)
      //   qr_bill_only → 1 PDF: rich appeal + BVR strip page 2 (the SOLE artefact)
      //   hybrid       → 2 PDFs: appeal letter sibling + rich QR-bill sibling
      // The dispatcher is extracted to keep this loop under the cognitive-
      // complexity ceiling.
      await emitWorkItemPdfs({
        archive,
        runMode,
        item,
        publicPageUrl,
        tenant,
        campaign,
        logoBuffer,
        swissQrCtx,
        orgId,
        campaignId,
        exportId,
      });

      uploaded += 1;

      // Tick progress after each PDF lands in the archive — the polling
      // UI sees real-time movement. Use `GREATEST(progress_count, $1)`
      // so a retry that re-mints fewer rows than a previous attempt
      // doesn't make the UI bar jump backwards (e.g. previous run got
      // to 5/10, retry starts at 1 — without GREATEST the bar regresses).
      await withWorkerContext(orgId, async (tx) => {
        await tx
          .update(campaignPostalExports)
          .set({
            progressCount: sql`GREATEST(${campaignPostalExports.progressCount}, ${uploaded})`,
            updatedAt: new Date(),
          })
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

/**
 * Epic #318 PR #4 MAJOR-1 follow-up — assert that the run mode the API
 * stamped at enqueue time still matches the mode the worker re-resolves
 * from live inputs at pickup time. The API readiness gate ran the same
 * resolver and stamped `run_mode` on the row before emitting the outbox
 * event; if the live inputs (bank-account link, public-page presence)
 * changed in the meantime — operator unlinked the bank account or
 * archived the page — we'd silently ship a ZIP whose contents don't
 * match the export panel the operator clicked Generate from. Fail loud
 * with `postal_export_mode_drift` and `markFailed` instead.
 *
 * NULL `stampedRunMode` = legacy row from before migration 0045; we
 * skip the assertion to keep history exports retrying cleanly through
 * the BullMQ retry path until those rows age out.
 *
 * Extracted from `processGeneratePostalExport` to keep that function
 * under the biome cognitive-complexity ceiling.
 */
async function assertNoRunModeDrift(args: {
  orgId: string;
  exportId: string;
  stampedRunMode: string | null;
  liveRunMode: PostalExportRunMode;
  log: ReturnType<typeof jobLogger>;
}): Promise<void> {
  if (args.stampedRunMode === null) return; // legacy row — skip
  if (args.stampedRunMode === args.liveRunMode) return; // happy path
  const message = `postal_export_mode_drift: stamped=${args.stampedRunMode} live=${args.liveRunMode} (operator unconfigured an input between enqueue and pickup)`;
  args.log.error(
    { exportId: args.exportId, stampedRunMode: args.stampedRunMode, liveRunMode: args.liveRunMode },
    message,
  );
  await markFailed(args.orgId, args.exportId, message);
  throw new Error(message);
}

/**
 * Epic #318 — load the Swiss QR-bill render context when the campaign
 * has a linked bank account, otherwise null. Extracted from
 * `processGeneratePostalExport` to keep that function under the
 * cognitive-complexity ceiling.
 */
async function loadSwissQrCtxIfActive(args: {
  orgId: string;
  exportId: string;
  bankAccountId: string | null;
  qrReferenceMode: "auto" | "qrr" | "scor";
  campaignName: string;
  log: ReturnType<typeof jobLogger>;
}): Promise<SwissQrBillRenderContext | null> {
  if (args.bankAccountId === null) return null;
  const account = await loadBankAccountForRender(args.orgId, args.bankAccountId);
  if (!account) {
    // The readiness gate already rejected this, but a stale postal-
    // export row pointing at a since-soft-deleted bank account would
    // crash the render. Bail out cleanly.
    throw new Error(
      `Swiss QR-bill mode: linked bank account ${args.bankAccountId} is missing or soft-deleted`,
    );
  }
  const referenceType = resolveReferenceType(args.qrReferenceMode, account.ibanKind);
  args.log.info(
    {
      exportId: args.exportId,
      bankAccountId: account.id,
      ibanKind: account.ibanKind,
      referenceType,
    },
    "Swiss QR-bill mode active — appending qr-bill.pdf per recipient",
  );
  return { bankAccount: account, referenceType, campaignName: args.campaignName };
}

/**
 * Epic #318 PR #4 — mode-aware PDF emission for one work item. Dispatches
 * on the resolved `runMode`:
 *
 *   - `standard`     → append 1 PDF: the appeal letter with scan-QR. No
 *                      QR-bill (no bank account linked). Today's default.
 *   - `qr_bill_only` → mint a QR-bill reference, render the 2-page bundle
 *                      (rich page 1 + BVR strip page 2), append as the
 *                      SOLE artefact for this recipient at `{name}.pdf`.
 *                      Skip the standalone appeal letter — page 1 of the
 *                      QR-bill PDF carries the same content.
 *   - `hybrid`       → append the appeal letter PDF + the rich QR-bill
 *                      sibling at `{name}-qr-bill.pdf`. Both PDFs carry
 *                      the appeal content; the appeal letter has the
 *                      scan-QR CTA, the QR-bill has the BVR strip.
 *   - `blocked`      → unreachable; guarded earlier.
 *
 * Extracted from the main loop to keep `processGeneratePostalExport`
 * under the biome cognitive-complexity ceiling.
 */
async function emitWorkItemPdfs(args: {
  archive: archiver.Archiver;
  runMode: PostalExportRunMode;
  item: {
    qrToken: string;
    constituentId: string | null;
    fileName: string;
    recipient: CampaignLetterRecipient | null;
  };
  publicPageUrl: string;
  tenant: { name: string; mission: string | null; defaultLocale: Locale };
  campaign: { name: string; description: string | null; bankAccountId: string | null };
  logoBuffer: Buffer | null;
  swissQrCtx: SwissQrBillRenderContext | null;
  orgId: string;
  campaignId: string;
  exportId: string;
}): Promise<void> {
  const { archive, runMode, item, publicPageUrl, tenant, campaign, logoBuffer, swissQrCtx } = args;

  // Self-defending dispatcher (minor #11 from PR #355 review): the caller's
  // mode resolver guards `blocked` upstream, but a refactor that reorders
  // the early-exit could silently fall through here with `blocked` and
  // emit zero PDFs for the recipient — the export would then mark
  // `completed` with an empty ZIP. Make the contract explicit at the
  // module boundary so a future regression fails loud.
  if (runMode === "blocked") {
    throw new Error(
      `emitWorkItemPdfs invoked with runMode=blocked for export ${args.exportId} — caller MUST guard this upstream`,
    );
  }

  // Standard rail (appeal letter with scan-QR) — emit in `standard` + `hybrid`.
  if (runMode === "standard" || runMode === "hybrid") {
    const letterBuffer = await renderPdfBuffer({
      organisationName: tenant.name,
      organisationMission: tenant.mission,
      logoBuffer,
      campaignName: campaign.name,
      campaignDescription: campaign.description,
      locale: tenant.defaultLocale,
      qrCode: `${publicPageUrl}?qr=${encodeURIComponent(item.qrToken)}`,
      qrReference: item.qrToken,
      recipient: item.recipient,
    });
    archive.append(letterBuffer, { name: item.fileName });
  }

  // Swiss QR-bill rail — emit in `qr_bill_only` + `hybrid`.
  if (
    (runMode === "qr_bill_only" || runMode === "hybrid") &&
    swissQrCtx &&
    campaign.bankAccountId
  ) {
    const { reference } = await ensureSwissQrReference({
      orgId: args.orgId,
      campaignId: args.campaignId,
      exportId: args.exportId,
      bankAccountId: campaign.bankAccountId,
      constituentId: item.constituentId,
      referenceType: swissQrCtx.referenceType,
      currency: swissQrCtx.bankAccount.currency,
    });
    const qrBillBuffer = await renderSwissQrBillPdf({
      bankAccount: swissQrCtx.bankAccount,
      reference,
      campaignName: campaign.name,
      campaignDescription: campaign.description,
      organisationName: tenant.name,
      organisationMission: tenant.mission,
      logoBuffer,
      locale: tenant.defaultLocale,
      recipient: item.recipient,
    });
    // QR-bill-only: SOLE PDF for this recipient → use the bare filename.
    // Hybrid: SIBLING PDF → suffix `-qr-bill`.
    const qrBillFileName =
      runMode === "qr_bill_only" ? item.fileName : qrBillFilenameFor(item.fileName);
    archive.append(qrBillBuffer, { name: qrBillFileName });
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
