/** Dashboard service — month-over-month KPI aggregates */

import { campaigns, constituents, donations } from "@givernance/shared/schema";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface DashboardPeriod {
  current: number;
  previous: number;
}

export interface DashboardStats {
  totalRaisedCents: DashboardPeriod;
  newDonors: DashboardPeriod;
  newActiveCampaigns: DashboardPeriod;
}

interface MonthRanges {
  current: { start: Date; end: Date };
  previous: { start: Date; end: Date };
}

/**
 * Half-open calendar-month windows in UTC.
 * `current` is the running month (1st 00:00 UTC → next 1st 00:00 UTC).
 * `previous` is the full prior month.
 */
export function monthRanges(now: Date = new Date()): MonthRanges {
  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return {
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: currentStart },
  };
}

export async function getDashboardStats(
  orgId: string,
  now: Date = new Date(),
): Promise<DashboardStats> {
  const ranges = monthRanges(now);

  return withTenantContext(orgId, async (tx) => {
    const [donationsAgg] = await tx
      .select({
        currentSum: sql<string>`COALESCE(SUM(${donations.amountCents}) FILTER (WHERE ${donations.donatedAt} >= ${ranges.current.start} AND ${donations.donatedAt} < ${ranges.current.end}), 0)`,
        previousSum: sql<string>`COALESCE(SUM(${donations.amountCents}) FILTER (WHERE ${donations.donatedAt} >= ${ranges.previous.start} AND ${donations.donatedAt} < ${ranges.previous.end}), 0)`,
      })
      .from(donations)
      .where(
        and(
          eq(donations.orgId, orgId),
          gte(donations.donatedAt, ranges.previous.start),
          lt(donations.donatedAt, ranges.current.end),
        ),
      );

    const [donorsAgg] = await tx
      .select({
        currentCount: sql<string>`COUNT(*) FILTER (WHERE ${constituents.createdAt} >= ${ranges.current.start} AND ${constituents.createdAt} < ${ranges.current.end})`,
        previousCount: sql<string>`COUNT(*) FILTER (WHERE ${constituents.createdAt} >= ${ranges.previous.start} AND ${constituents.createdAt} < ${ranges.previous.end})`,
      })
      .from(constituents)
      .where(
        and(
          eq(constituents.orgId, orgId),
          eq(constituents.type, "donor"),
          gte(constituents.createdAt, ranges.previous.start),
          lt(constituents.createdAt, ranges.current.end),
        ),
      );

    const [campaignsAgg] = await tx
      .select({
        currentCount: sql<string>`COUNT(*) FILTER (WHERE ${campaigns.createdAt} >= ${ranges.current.start} AND ${campaigns.createdAt} < ${ranges.current.end})`,
        previousCount: sql<string>`COUNT(*) FILTER (WHERE ${campaigns.createdAt} >= ${ranges.previous.start} AND ${campaigns.createdAt} < ${ranges.previous.end})`,
      })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.orgId, orgId),
          eq(campaigns.status, "active"),
          gte(campaigns.createdAt, ranges.previous.start),
          lt(campaigns.createdAt, ranges.current.end),
        ),
      );

    return {
      totalRaisedCents: {
        current: Number(donationsAgg?.currentSum ?? 0),
        previous: Number(donationsAgg?.previousSum ?? 0),
      },
      newDonors: {
        current: Number(donorsAgg?.currentCount ?? 0),
        previous: Number(donorsAgg?.previousCount ?? 0),
      },
      newActiveCampaigns: {
        current: Number(campaignsAgg?.currentCount ?? 0),
        previous: Number(campaignsAgg?.previousCount ?? 0),
      },
    };
  });
}
