/**
 * Branding asset garbage-collector — Epic #286.
 *
 * Runs after the API soft-deletes an asset row (operator clicks
 * "remove logo"). Drops every S3 object under the asset's prefix and
 * enqueues a follow-up KC sync so the org's `logo_url` attribute is
 * cleared. The DB row stays around (audit) — only the S3 binaries
 * and the KC public URL pointer are wiped.
 */

import { BRANDING_EVENT_TYPES, type BrandingGcAssetJob } from "@givernance/shared/jobs";
import { outboxEvents } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { deleteBrandingPrefix } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";

export async function processBrandingGcAsset(
  job: Job<BrandingGcAssetJob["data"] & { traceparent?: string }>,
): Promise<{ deleted: number }> {
  const { assetId, orgId, prefix, traceparent } = job.data;
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  const deleted = await deleteBrandingPrefix(prefix);
  log.info({ assetId, prefix, deleted }, "Branding asset S3 prefix deleted");

  // Enqueue the KC sync to clear the `logo_url` attribute. We do NOT
  // do it inline so this job can complete fast even if KC is down.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO,
      payload: { orgId },
      metadata: traceparent ? { traceparent } : null,
    });
  });

  return { deleted };
}
