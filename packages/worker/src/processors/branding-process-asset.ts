/**
 * Branding asset processor — Epic #286.
 *
 * Loads the freshly-uploaded `org_branding_assets` row, fetches the
 * sanitised original from S3, runs the variant pipeline, uploads the
 * four derivatives, and flips the row to `status='ready'`. On any
 * failure the row is flipped to `status='failed'` with a captured
 * error message for the admin UI.
 *
 * Idempotency: the row's `status='pending'` short-circuits to a no-op
 * if a previous attempt already flipped to `ready` (BullMQ retry after
 * a successful run + ack failure). Variant uploads use deterministic
 * keys (`{org}/logo/{asset}/{variant}.{ext}`), so a retry overwrites
 * the previous (incomplete) variant set without leaving orphans.
 */

import { BRANDING_EVENT_TYPES, type BrandingProcessAssetJob } from "@givernance/shared/jobs";
import {
  type BrandingAssetVariants,
  type BrandingVariantKey,
  orgBrandingAssets,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { getBrandingObject, putBrandingObject } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import { runBrandingPipeline, variantExtension } from "../services/branding-pipeline.js";

const VARIANT_KEYS: BrandingVariantKey[] = ["sidebar", "preview", "public-hero", "pdf-letterhead"];

function variantKey(orgId: string, assetId: string, variant: BrandingVariantKey): string {
  return `${orgId}/logo/${assetId}/${variant}.${variantExtension(variant)}`;
}

export async function processBrandingAsset(
  job: Job<BrandingProcessAssetJob["data"] & { traceparent?: string }>,
): Promise<{ status: "ready" | "failed" | "skipped" }> {
  const { assetId, orgId, traceparent } = job.data;
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  log.info({ assetId }, "Branding pipeline start");

  // ── Load row ────────────────────────────────────────────────────────
  const [row] = await withWorkerContext(orgId, async (tx) =>
    tx
      .select()
      .from(orgBrandingAssets)
      .where(and(eq(orgBrandingAssets.id, assetId), eq(orgBrandingAssets.orgId, orgId))),
  );

  if (!row) {
    log.warn({ assetId }, "Branding asset row not found — skipping");
    return { status: "skipped" };
  }

  if (row.status === "ready") {
    log.info({ assetId }, "Branding asset already processed — idempotent skip");
    return { status: "skipped" };
  }

  if (row.deletedAt) {
    log.info({ assetId }, "Branding asset soft-deleted before processing — skipping");
    return { status: "skipped" };
  }

  try {
    // ── Fetch original from S3 ────────────────────────────────────────
    const originalBuffer = await getBrandingObject(row.originalKey);
    if (!originalBuffer) {
      throw new Error(`Original asset missing in S3: ${row.originalKey}`);
    }

    // ── Run pipeline ──────────────────────────────────────────────────
    const result = await runBrandingPipeline(originalBuffer, row.originalContentType);

    // ── Upload variants ──────────────────────────────────────────────
    const variants: BrandingAssetVariants = {};
    for (const key of VARIANT_KEYS) {
      const variant = result.variants[key];
      const s3Key = variantKey(orgId, assetId, key);
      await putBrandingObject(s3Key, variant.buffer, variant.contentType);
      // Use the canonical sizes — the pipeline produces square `contain`-
      // fitted variants so we report the bounding box dimensions, which
      // the frontend uses for `<img width height>` attributes to avoid
      // CLS (cumulative layout shift) on first paint.
      variants[key] = {
        key: s3Key,
        contentType: variant.contentType,
        width: variantBoxSize(key),
        height: variantBoxSize(key),
      };
    }

    // ── Flip row to ready + enqueue activation ───────────────────────
    // Same transaction as the row flip so the relay can never deliver
    // `branding.activate_logo` before the row is observably `ready`.
    // This replaces the previous design where the API handler enqueued
    // both events at upload time and relied on the activate processor
    // to re-queue itself if it ran first — BullMQ treats a
    // `{ activated: false }` return as success (no retry), so an out-
    // of-order delivery silently stranded the tenant pointer at NULL.
    // PR #287 review (blocker 3).
    await withWorkerContext(orgId, async (tx) => {
      await tx
        .update(orgBrandingAssets)
        .set({
          status: "ready",
          variants,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          updatedAt: new Date(),
        })
        .where(and(eq(orgBrandingAssets.id, assetId), eq(orgBrandingAssets.orgId, orgId)));

      await tx.insert(outboxEvents).values({
        tenantId: orgId,
        type: BRANDING_EVENT_TYPES.ACTIVATE_LOGO,
        payload: { assetId, orgId },
        metadata: traceparent ? { traceparent } : null,
      });
    });

    log.info(
      { assetId, sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight },
      "Branding pipeline ready; activation enqueued",
    );
    return { status: "ready" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ assetId, err: message }, "Branding pipeline failed");
    await withWorkerContext(orgId, async (tx) => {
      await tx
        .update(orgBrandingAssets)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(and(eq(orgBrandingAssets.id, assetId), eq(orgBrandingAssets.orgId, orgId)));
    });
    throw err;
  }
}

function variantBoxSize(key: BrandingVariantKey): number {
  switch (key) {
    case "sidebar":
      return 128;
    case "preview":
      return 240;
    case "public-hero":
      return 800;
    case "pdf-letterhead":
      return 360;
  }
}
