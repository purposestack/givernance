/**
 * Branding service — Epic #286.
 *
 * Owns the DB writes for the org-logo upload flow. Three operations:
 *
 *   - `createPendingAsset` — INSERT a new `org_branding_assets` row in
 *     `status='pending'` plus the `branding.process_asset` outbox event
 *     in a single transaction so the job dispatch and the row are atomic.
 *     The downstream `branding.activate_logo` event is emitted by the
 *     worker pipeline itself, AFTER the row commits to `status='ready'`,
 *     so activation ordering is causal at the DB level (PR #287 review,
 *     blocker 3).
 *   - `getActiveLogoAsset` — read-only fetch of the currently active
 *     logo asset (or null if none configured).
 *   - `softDeleteLogoAsset` — clears `tenants.logo_asset_id`,
 *     soft-deletes the asset row, enqueues the GC outbox event.
 *
 * All writes go through `withTenantContext` so RLS pins reads/writes
 * to the caller's org.
 */

import { BRANDING_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  type BrandingAssetType,
  type OrgBrandingAsset,
  orgBrandingAssets,
  outboxEvents,
  tenants,
} from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

/**
 * Insert a freshly-uploaded asset row in `pending` status and enqueue
 * the worker pipeline + activation events. Idempotency is handled at
 * the worker layer: re-running the pipeline against a `ready` asset is
 * a no-op (see `branding-process-asset.ts`).
 */
export async function createPendingAsset(input: {
  orgId: string;
  assetType: BrandingAssetType;
  originalKey: string;
  originalContentType: string;
  originalBytes: number;
  uploadedBy: string | null;
  traceparent?: string;
}): Promise<OrgBrandingAsset> {
  return withTenantContext(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(orgBrandingAssets)
      .values({
        orgId: input.orgId,
        assetType: input.assetType,
        status: "pending",
        originalKey: input.originalKey,
        originalContentType: input.originalContentType,
        originalBytes: input.originalBytes,
        uploadedBy: input.uploadedBy,
      })
      .returning();
    if (!row) throw new Error("Failed to insert org_branding_assets row");

    // Outbox: enqueue ONLY the pipeline event. The activation event
    // (`branding.activate_logo`) is emitted at the END of
    // `processBrandingAsset` AFTER the row is flipped to `status='ready'`
    // — that makes the ordering causal at the database level, so the
    // activation processor never sees a not-ready row. The previous
    // implementation enqueued both events here and relied on the
    // activate processor to re-queue itself if it landed first, but
    // BullMQ treats a `{ activated: false }` return as success (no
    // retry), so an out-of-order delivery silently stranded the
    // tenant pointer at NULL. See PR #287 review (blocker 3).
    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: BRANDING_EVENT_TYPES.PROCESS_ASSET,
      payload: { assetId: row.id, orgId: input.orgId },
      metadata: input.traceparent ? { traceparent: input.traceparent } : null,
    });

    return row;
  });
}

/**
 * Resolve the org's active logo asset (the row pointed to by
 * `tenants.logo_asset_id`). Returns null when no logo is configured,
 * the asset is not ready, or the asset has been soft-deleted.
 */
export async function getActiveLogoAsset(orgId: string): Promise<OrgBrandingAsset | null> {
  return withTenantContext(orgId, async (tx) => {
    const [tenant] = await tx
      .select({ logoAssetId: tenants.logoAssetId })
      .from(tenants)
      .where(eq(tenants.id, orgId));
    if (!tenant?.logoAssetId) return null;

    const [asset] = await tx
      .select()
      .from(orgBrandingAssets)
      .where(
        and(
          eq(orgBrandingAssets.id, tenant.logoAssetId),
          eq(orgBrandingAssets.orgId, orgId),
          isNull(orgBrandingAssets.deletedAt),
        ),
      );
    return asset ?? null;
  });
}

/**
 * Read the most recent (any status) logo asset for the org — used by
 * the GET endpoint to surface a still-processing upload as well as a
 * ready one. Returns null if no logo upload has ever been made.
 */
export async function getLatestLogoAsset(orgId: string): Promise<OrgBrandingAsset | null> {
  return withTenantContext(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(orgBrandingAssets)
      .where(
        and(
          eq(orgBrandingAssets.orgId, orgId),
          eq(orgBrandingAssets.assetType, "org_logo"),
          isNull(orgBrandingAssets.deletedAt),
        ),
      )
      .orderBy(orgBrandingAssets.createdAt);
    return rows.at(-1) ?? null;
  });
}

/**
 * Soft-delete the org's active logo: clears `tenants.logo_asset_id`,
 * marks the asset row deleted, and emits the `branding.gc_asset`
 * outbox event so the worker cleans up S3 + clears the KC attribute.
 *
 * Returns true when something was actually deleted, false when there
 * was no active logo (idempotent — no-op if the operator double-clicks).
 */
export async function softDeleteActiveLogo(input: {
  orgId: string;
  traceparent?: string;
}): Promise<boolean> {
  return withTenantContext(input.orgId, async (tx) => {
    const [tenant] = await tx
      .select({ logoAssetId: tenants.logoAssetId })
      .from(tenants)
      .where(eq(tenants.id, input.orgId));
    if (!tenant?.logoAssetId) return false;

    const [asset] = await tx
      .select({ id: orgBrandingAssets.id, originalKey: orgBrandingAssets.originalKey })
      .from(orgBrandingAssets)
      .where(
        and(eq(orgBrandingAssets.id, tenant.logoAssetId), eq(orgBrandingAssets.orgId, input.orgId)),
      );
    if (!asset) return false;

    // Clear the active pointer first so any in-flight read sees no
    // logo, then mark the asset row deleted.
    await tx
      .update(tenants)
      .set({ logoAssetId: null, updatedAt: new Date() })
      .where(eq(tenants.id, input.orgId));

    await tx
      .update(orgBrandingAssets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(orgBrandingAssets.id, asset.id));

    // Compose the S3 prefix from the original key — the GC job uses
    // this to drop the entire `{org}/logo/{asset}/` directory in one
    // ListObjects + DeleteObjects sweep.
    // `originalKey` is `{org}/logo/{asset}/original.{ext}` so we strip
    // the filename to get the prefix.
    const lastSlash = asset.originalKey.lastIndexOf("/");
    const prefix =
      lastSlash > 0 ? `${asset.originalKey.substring(0, lastSlash)}/` : asset.originalKey;

    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: BRANDING_EVENT_TYPES.GC_ASSET,
      payload: { assetId: asset.id, orgId: input.orgId, prefix },
      metadata: input.traceparent ? { traceparent: input.traceparent } : null,
    });

    return true;
  });
}
