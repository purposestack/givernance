/**
 * Postal-export service — async PDF/ZIP archive generation for postal
 * campaigns (Epic #274). The HTTP path stays under 100ms; all heavy lifting
 * (PDF rendering, ZIP bundling, S3 upload) runs in the BullMQ worker.
 *
 * Lifecycle:
 *   1. POST /campaigns/:id/postal-exports → service inserts a `pending` row,
 *      emits `campaign.postal_export_requested`, returns the row id.
 *   2. Outbox relay → BullMQ → worker `postal-export.ts` flips status to
 *      `processing`, ticks `progressCount` per PDF, uploads ZIP, marks
 *      `completed` (with `zipS3Path`) or `failed` (with `error`).
 *   3. Frontend polls GET /campaigns/:id/postal-exports/:exportId every ~2s
 *      to render the progress bar.
 *   4. GET /campaigns/:id/postal-exports/:exportId/download streams the
 *      ZIP from S3 through the API (mirrors the receipts download pattern
 *      from issue #214 — keeps the donor-visible URL on the app's apex
 *      and avoids signed-URL hostname issues on the staging MinIO).
 */

import {
  campaignConstituents,
  campaignPostalExports,
  campaigns,
  constituents,
  outboxEvents,
  type PostalExportMode,
} from "@givernance/shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import { resolveInternalUserId } from "../../lib/resolve-user.js";

export class PostalExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostalExportError";
  }
}

export interface PostalExportRow {
  id: string;
  campaignId: string;
  mode: PostalExportMode;
  status: "pending" | "processing" | "completed" | "failed";
  totalCount: number;
  progressCount: number;
  zipS3Path: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: {
  id: string;
  campaignId: string;
  mode: PostalExportMode;
  status: "pending" | "processing" | "completed" | "failed";
  totalCount: number;
  progressCount: number;
  zipS3Path: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}): PostalExportRow {
  return {
    id: row.id,
    campaignId: row.campaignId,
    mode: row.mode,
    status: row.status,
    totalCount: row.totalCount,
    progressCount: row.progressCount,
    zipS3Path: row.zipS3Path,
    error: row.error,
    requestedBy: row.requestedBy,
    // biome-ignore lint/style/noNonNullAssertion: Drizzle returns Date for these timestamp columns
    createdAt: toIso(row.createdAt)!,
    // biome-ignore lint/style/noNonNullAssertion: same
    updatedAt: toIso(row.updatedAt)!,
    completedAt: toIso(row.completedAt),
  };
}

/** Count linked constituents for a campaign (used to lock the totalCount at job-start). */
async function countLinkedConstituents(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignConstituents)
    .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
    .where(
      and(
        eq(campaignConstituents.orgId, orgId),
        eq(campaignConstituents.campaignId, campaignId),
        isNull(constituents.deletedAt),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Start a new postal export job.
 *
 * For `personalized` mode the campaign must be `nominative_postal` and have
 * at least one linked constituent — bouncing the request here keeps the
 * worker focused on actual work (no "0 PDFs in a ZIP" empty-archive jobs).
 *
 * For `door_drop` mode any campaign type works (the door-drop letter is
 * generic by definition); `totalCount` is locked to 1 — we generate one
 * representative PDF + QR code that the org can mass-print themselves.
 */
export async function startPostalExport(
  orgId: string,
  userId: string,
  campaignId: string,
  mode: PostalExportMode,
): Promise<PostalExportRow | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id, type: campaigns.type })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    let totalCount = 0;
    if (mode === "personalized") {
      if (campaign.type === "door_drop") {
        throw new PostalExportError(
          "Cannot run a personalized export on a door-drop campaign — switch the export mode to door_drop or use a nominative campaign",
        );
      }
      totalCount = await countLinkedConstituents(tx, orgId, campaignId);
      if (totalCount === 0) {
        throw new PostalExportError(
          "Personalized export requires at least one linked constituent. Add recipients to the campaign first.",
        );
      }
    } else {
      totalCount = 1;
    }

    // `userId` is the JWT subject (= keycloak id). `requested_by` is a
    // FK to `users.id` (internal UUID), so we MUST translate. Falls back
    // to NULL when the JWT subject doesn't match an active member of
    // the tenant (impersonated platform admin in delegation mode against
    // a tenant they don't belong to — the audit trail still captures
    // `actor_id` and `impersonation_session_id` separately).
    const requestedByInternal = await resolveInternalUserId(tx, orgId, userId);

    const [inserted] = await tx
      .insert(campaignPostalExports)
      .values({
        orgId,
        campaignId,
        mode,
        status: "pending",
        totalCount,
        progressCount: 0,
        requestedBy: requestedByInternal,
      })
      .returning();

    if (!inserted) {
      throw new PostalExportError("Failed to enqueue postal export");
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.postal_export_requested",
      payload: {
        exportId: inserted.id,
        campaignId,
        mode,
        totalCount,
        // Outbox payload keeps the JWT subject (= keycloak id) — it's an
        // opaque audit trail value, not an FK.
        requestedBy: userId,
      },
    });

    return mapRow(inserted);
  });
}

/** List recent postal exports for a campaign (newest first, no pagination — capped at 20). */
export async function listPostalExports(
  orgId: string,
  campaignId: string,
): Promise<PostalExportRow[] | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const rows = await tx
      .select()
      .from(campaignPostalExports)
      .where(
        and(
          eq(campaignPostalExports.orgId, orgId),
          eq(campaignPostalExports.campaignId, campaignId),
        ),
      )
      .orderBy(desc(campaignPostalExports.createdAt))
      .limit(20);

    return rows.map(mapRow);
  });
}

/** Get a single postal export by id. Used for polling progress. */
export async function getPostalExport(
  orgId: string,
  campaignId: string,
  exportId: string,
): Promise<PostalExportRow | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(campaignPostalExports)
      .where(
        and(
          eq(campaignPostalExports.id, exportId),
          eq(campaignPostalExports.orgId, orgId),
          eq(campaignPostalExports.campaignId, campaignId),
        ),
      );

    return row ? mapRow(row) : null;
  });
}
