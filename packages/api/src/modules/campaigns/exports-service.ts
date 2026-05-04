/**
 * Campaign export jobs service (Epic #274).
 *
 * Owns the lifecycle of the asynchronous ZIP archive generation: creates
 * job rows, exposes status snapshots for polling, and resolves a
 * short-lived signed URL for the final archive once the worker uploads it.
 *
 * The HTTP handler returns immediately with a job id; the BullMQ worker
 * progressively updates `progressTotal` / `progressDone` so the front-end
 * can drive a progress bar without holding the request open.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type CampaignExportMode,
  campaignConstituents,
  campaignExportJobs,
  campaigns,
  outboxEvents,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../env.js";
import { withTenantContext } from "../../lib/db.js";

/** Signed URL TTL for the final ZIP archive — short enough to avoid stale links being shared. */
const ARCHIVE_URL_TTL_SECONDS = 600;

/** Initialize the S3 client lazily so test env can stub `env`. */
let s3Singleton: S3Client | null = null;
function s3Client(): S3Client {
  if (!s3Singleton) {
    s3Singleton = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Singleton;
}

export interface CampaignExportJobRow {
  id: string;
  orgId: string;
  campaignId: string;
  mode: CampaignExportMode;
  status: "pending" | "processing" | "completed" | "failed";
  progressTotal: number;
  progressDone: number;
  archiveS3Path: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignExportJobView extends CampaignExportJobRow {
  /** Pre-signed download URL — only set when status === "completed". */
  downloadUrl: string | null;
  /** 0-100 integer progress percentage, capped to 100 for completed jobs. */
  progressPct: number;
}

export class ExportJobError extends Error {
  constructor(
    message: string,
    readonly code: "campaign_not_found" | "no_recipients" | "job_not_found",
  ) {
    super(message);
    this.name = "ExportJobError";
  }
}

/** Inclusive `progressPct` derivation — caps at 100, returns 0 for empty totals. */
export function computeProgressPct(total: number, done: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}

/**
 * Create a new export job. Returns the persisted job row plus the outbox
 * event payload — the route handler is responsible for committing both in
 * a single transaction (we already do here via `withTenantContext`).
 *
 * For `nominative` mode, computes `progressTotal` from the count of linked
 * constituents at request time. The worker re-reads the linked list to
 * fan out PDF generation, so a constituent attached after the job is
 * created will NOT be included — by design, the snapshot lives at the
 * `campaign_export_jobs` row level.
 */
export async function createExportJob(
  orgId: string,
  campaignId: string,
  mode: CampaignExportMode,
  userId: string | null,
): Promise<CampaignExportJobRow> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id, type: campaigns.type })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) {
      throw new ExportJobError("Campaign not found", "campaign_not_found");
    }

    let progressTotal = 0;
    if (mode === "nominative") {
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(campaignConstituents)
        .where(
          and(
            eq(campaignConstituents.orgId, orgId),
            eq(campaignConstituents.campaignId, campaignId),
          ),
        );
      progressTotal = Number(count);
      if (progressTotal === 0) {
        throw new ExportJobError(
          "No constituents linked to this campaign — attach recipients before generating a nominative export",
          "no_recipients",
        );
      }
    } else {
      // Door-drop archives are a single generic letter — total = 1.
      progressTotal = 1;
    }

    const [job] = await tx
      .insert(campaignExportJobs)
      .values({
        orgId,
        campaignId,
        requestedByUserId: userId,
        mode,
        status: "pending",
        progressTotal,
        progressDone: 0,
      })
      .returning();

    if (!job) {
      throw new Error("createExportJob: insert returned no row");
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.export_requested",
      payload: {
        exportJobId: job.id,
        campaignId,
        mode,
        progressTotal,
        requestedBy: userId,
      },
    });

    return job as CampaignExportJobRow;
  });
}

/**
 * Fetch a job snapshot for polling, augmented with a presigned download
 * URL when the archive is ready. Returns `null` when the job does not exist
 * (or belongs to another tenant — RLS filters the row out).
 */
export async function getExportJobView(
  orgId: string,
  campaignId: string,
  jobId: string,
): Promise<CampaignExportJobView | null> {
  return withTenantContext(orgId, async (tx) => {
    const [job] = await tx
      .select()
      .from(campaignExportJobs)
      .where(
        and(
          eq(campaignExportJobs.id, jobId),
          eq(campaignExportJobs.orgId, orgId),
          eq(campaignExportJobs.campaignId, campaignId),
        ),
      );

    if (!job) return null;

    const row: CampaignExportJobRow = {
      id: job.id,
      orgId: job.orgId,
      campaignId: job.campaignId,
      mode: job.mode as CampaignExportMode,
      status: job.status as CampaignExportJobRow["status"],
      progressTotal: job.progressTotal,
      progressDone: job.progressDone,
      archiveS3Path: job.archiveS3Path,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };

    let downloadUrl: string | null = null;
    if (row.status === "completed" && row.archiveS3Path) {
      try {
        downloadUrl = await getSignedUrl(
          s3Client(),
          new GetObjectCommand({
            Bucket: env.S3_CAMPAIGNS_BUCKET,
            Key: row.archiveS3Path,
          }),
          { expiresIn: ARCHIVE_URL_TTL_SECONDS },
        );
      } catch {
        // Don't crash the polling endpoint if the bucket is briefly
        // unavailable — the client will see `downloadUrl: null` and
        // retry on next poll.
        downloadUrl = null;
      }
    }

    return {
      ...row,
      downloadUrl,
      progressPct:
        row.status === "completed" ? 100 : computeProgressPct(row.progressTotal, row.progressDone),
    };
  });
}

/**
 * List recent export jobs for a campaign — used by the admin panel to show
 * historical exports next to the "Generate ZIP" button.
 */
export async function listCampaignExportJobs(
  orgId: string,
  campaignId: string,
  limit = 10,
): Promise<CampaignExportJobRow[]> {
  return withTenantContext(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(campaignExportJobs)
      .where(
        and(eq(campaignExportJobs.orgId, orgId), eq(campaignExportJobs.campaignId, campaignId)),
      )
      .orderBy(sql`${campaignExportJobs.createdAt} DESC`)
      .limit(limit);

    return rows.map(
      (job) =>
        ({
          ...job,
          mode: job.mode as CampaignExportMode,
          status: job.status as CampaignExportJobRow["status"],
        }) as CampaignExportJobRow,
    );
  });
}
