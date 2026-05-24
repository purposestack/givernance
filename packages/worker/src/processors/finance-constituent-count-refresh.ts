// #436 — finance.constituent_count_refresh
/**
 * Daily cron job — refreshes `tenants.constituent_count_cached` for every
 * non-archived/non-suspended tenant.
 *
 * Why: the super-admin finance dashboard (Epic #434) renders a per-tenant
 * "constituents" tile. A live `COUNT(*) FROM constituents GROUP BY org_id`
 * over the whole platform on every page render would scan every row of
 * every tenant in turn. The cached column is updated nightly so the page
 * loads in milliseconds and the `fresh-pip` UI surfaces the staleness.
 *
 * Topology: iterates tenant-by-tenant so the COUNT runs scoped per tenant
 * (and is resistant to future RLS-scope confusion — see CLAUDE.md
 * § "RLS is the safety net, never the contract"). For ~50 tenants this is
 * trivial load; if the platform ever grows past O(thousands) we'll
 * revisit with a single GROUP BY + UPDATE FROM aggregate.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { constituents, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

export async function processConstituentCountRefresh(job: Job): Promise<void> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });

  const flagOn = await isFlagEnabled(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD);
  if (!flagOn) {
    log.info("admin.finance_dashboard flag is off, skipping constituent count refresh");
    return;
  }

  // CROSS-TENANT INTENTIONAL: platform-wide cron sweep — every tenant's
  // count refresh happens in one job tick. Owner-pool (`db`) is used
  // because the next loop scopes the COUNT to a single org_id and
  // updates that tenant's row; we never read another tenant's data
  // without their org_id in the predicate.
  const candidates = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(sql`${tenants.status} NOT IN ('archived', 'suspended')`);

  let updated = 0;
  for (const tenant of candidates) {
    const orgId = tenant.id;
    try {
      // CROSS-TENANT INTENTIONAL: owner-pool COUNT scoped explicitly
      // by `eq(constituents.orgId, orgId)` — defence-in-depth even
      // while running under BYPASSRLS.
      const [row] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(constituents)
        .where(and(eq(constituents.orgId, orgId), isNull(constituents.deletedAt)));
      const count = row?.count ?? 0;

      await db
        .update(tenants)
        .set({
          constituentCountCached: count,
          constituentCountRefreshedAt: new Date(),
        })
        .where(eq(tenants.id, orgId));

      updated += 1;
    } catch (err) {
      // Per-tenant failures are logged but do not abort the sweep —
      // a single tenant with corrupt data should not starve the
      // dashboard freshness for all other tenants.
      const message = err instanceof Error ? err.message : "Unknown error";
      log.warn({ orgId, err: message }, "constituent count refresh failed for tenant");
    }
  }

  log.info({ totalTenants: candidates.length, updated }, "constituent count refresh complete");
}
