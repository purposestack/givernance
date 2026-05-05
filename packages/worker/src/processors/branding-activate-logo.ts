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

  if (!asset || asset.status !== "ready" || asset.deletedAt) {
    log.warn(
      { assetId, status: asset?.status, deletedAt: asset?.deletedAt },
      "Asset not eligible for activation (status≠ready or deleted) — skipping",
    );
    return { activated: false };
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
