/**
 * Keycloak `logo_url` sync processor — Epic #286.
 *
 * Reads the tenant's current `logo_asset_id`, composes the public URL
 * of the `public-hero` variant (or empty if no logo is configured),
 * and PUTs the value onto the KC organization's `attributes.logo_url`
 * via the GET-then-PUT pattern.
 *
 * Idempotent: writing the same URL twice is a no-op upstream. The
 * relay's at-least-once guarantee plus this idempotence makes the
 * pipeline safe under retries.
 *
 * Failure modes:
 *   - KC down → bubble up; BullMQ retries with exponential backoff.
 *   - Tenant missing `keycloakOrgId` → log warn + early-exit (the
 *     tenant predates Keycloak Organizations and doesn't need the
 *     attribute synced).
 *   - Asset row missing or not ready → emit empty `logo_url` so the
 *     KC template falls back to the Givernance default.
 */

import type { KeycloakSyncOrgLogoJob } from "@givernance/shared/jobs";
import { orgBrandingAssets, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.js";
import { updateOrganization } from "../lib/keycloak-admin.js";
import { jobLogger } from "../lib/logger.js";
import { brandingPublicUrl } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";

export async function processKeycloakSyncOrgLogo(
  job: Job<KeycloakSyncOrgLogoJob["data"] & { traceparent?: string }>,
): Promise<{ synced: boolean; logoUrl: string }> {
  const { orgId, traceparent } = job.data;
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  const [tenant] = await db
    .select({
      id: tenants.id,
      keycloakOrgId: tenants.keycloakOrgId,
      logoAssetId: tenants.logoAssetId,
    })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  if (!tenant) {
    log.warn({ orgId }, "Tenant not found — skipping KC logo sync");
    return { synced: false, logoUrl: "" };
  }

  if (!tenant.keycloakOrgId) {
    log.warn({ orgId }, "Tenant has no keycloakOrgId — skipping KC logo sync");
    return { synced: false, logoUrl: "" };
  }

  let logoUrl = "";
  if (tenant.logoAssetId) {
    const [asset] = await db
      .select({
        id: orgBrandingAssets.id,
        status: orgBrandingAssets.status,
        variants: orgBrandingAssets.variants,
        deletedAt: orgBrandingAssets.deletedAt,
      })
      .from(orgBrandingAssets)
      .where(eq(orgBrandingAssets.id, tenant.logoAssetId));

    if (asset && asset.status === "ready" && !asset.deletedAt) {
      const heroKey = asset.variants?.["public-hero"]?.key;
      if (heroKey) {
        logoUrl = brandingPublicUrl(heroKey);
      }
    }
  }

  // Empty array → KC drops the attribute (template's `?has_content`
  // check correctly treats it as "no logo set").
  await updateOrganization(tenant.keycloakOrgId, {
    attributes: { logo_url: logoUrl ? [logoUrl] : [] },
  });

  log.info({ orgId, logoUrl: logoUrl || "(cleared)" }, "KC organization logo_url synced");
  return { synced: true, logoUrl };
}
