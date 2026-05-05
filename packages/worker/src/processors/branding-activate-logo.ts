/**
 * Branding logo activation processor — Epic #286.
 *
 * Once `branding.process_asset` flips an asset to `status='ready'`,
 * this job points `tenants.logo_asset_id` at it and enqueues the
 * Keycloak attribute sync. Split into a separate job (rather than
 * folded into the pipeline) so:
 *   - The asset upload + variant generation can be retried in
 *     isolation without re-flipping the active pointer.
 *   - The KC sync stays decoupled from the bulk image work; a 502
 *     against KC won't fail-and-retry the (expensive) sharp pipeline.
 *
 * Ordering guarantee: this event is now emitted from
 * `processBrandingAsset` AFTER the row commits to `status='ready'`
 * (see PR #287 review, blocker 3). If we somehow observe a not-ready
 * row at activation time, that means the relay redelivered the event
 * out of order against expectations — we throw so BullMQ retries with
 * the queue's exponential backoff rather than silently dropping the
 * activation (which would strand `tenants.logo_asset_id` at NULL).
 */

import { BRANDING_EVENT_TYPES, type BrandingActivateLogoJob } from "@givernance/shared/jobs";
import { orgBrandingAssets, outboxEvents, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { extractTraceId } from "../lib/trace-context.js";

export async function processBrandingActivateLogo(
  job: Job<BrandingActivateLogoJob["data"] & { traceparent?: string }>,
): Promise<{ activated: boolean }> {
  const { assetId, orgId, traceparent } = job.data;
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  // Use the owner pool for the cross-table update (tenants is not
  // RLS-protected on read by `app_current_organization_id`, but is on
  // write — and the relay enqueues this job using the orgId from the
  // outbox row, which we trust as the source of truth).
  const [asset] = await db
    .select({
      id: orgBrandingAssets.id,
      orgId: orgBrandingAssets.orgId,
      status: orgBrandingAssets.status,
      deletedAt: orgBrandingAssets.deletedAt,
    })
    .from(orgBrandingAssets)
    .where(and(eq(orgBrandingAssets.id, assetId), eq(orgBrandingAssets.orgId, orgId)));

  // Asset row vanished or was soft-deleted between the pipeline-flip
  // commit and this run (race with `softDeleteActiveLogo`). Nothing to
  // do — return cleanly so BullMQ acks. We deliberately do NOT throw
  // here because the operator's deletion intent is the authoritative
  // signal and re-queuing would just spin until the deleted_at filter
  // wins anyway.
  if (!asset || asset.deletedAt) {
    log.warn(
      { assetId, deletedAt: asset?.deletedAt },
      "Asset row missing or soft-deleted — skipping activation",
    );
    return { activated: false };
  }

  // The activate event is emitted by `processBrandingAsset` AFTER the
  // row commits to `status='ready'`. Seeing a not-ready row here means
  // the relay redelivered out-of-order, or the pipeline regressed and
  // emitted activation prematurely. Throw so BullMQ retries with the
  // queue's exponential backoff — silently returning would strand
  // `tenants.logo_asset_id` at NULL forever (PR #287 review blocker 3).
  if (asset.status !== "ready") {
    log.warn(
      { assetId, status: asset.status },
      "Asset not yet ready — relay redelivered out of order; retrying",
    );
    throw new Error(
      `Branding asset ${assetId} not ready (status=${asset.status}); BullMQ will retry`,
    );
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    await tx
      .update(tenants)
      .set({ logoAssetId: assetId, updatedAt: new Date() })
      .where(eq(tenants.id, orgId));

    // Enqueue the KC sync via outbox so the relay handles retry +
    // breaker semantics consistently with other KC-bound jobs.
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO,
      payload: { orgId },
      metadata: traceparent ? { traceparent } : null,
    });
  });

  log.info({ assetId }, "Branding logo activated; KC sync enqueued");
  return { activated: true };
}
