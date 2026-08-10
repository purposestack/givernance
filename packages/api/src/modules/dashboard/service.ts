/** Dashboard service — month-over-month KPI aggregates */

import type { FxRateService } from "@givernance/shared/finance";
import {
  campaigns,
  constituents,
  donations,
  orgCurrencyBalances,
  tenants,
} from "@givernance/shared/schema";
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

export interface MultiCurrencyTotal {
  totalDisplayCents: number;
  displayCurrency: string;
  exchangeRateTimestamp: string | null;
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

/**
 * Aggregate all cleared balances from `org_currency_balances` into a single
 * display-currency total using FX rates from the Redis cache.
 *
 * Uses the org's `base_currency` as the display currency (the 80% case —
 * per-user display currency is deferred to a follow-up task).
 *
 * When a rate is unavailable (Fixer.io down / cache cold), that currency's
 * balance is skipped rather than failing the whole request. The caller
 * receives a partial total annotated with the latest rate timestamp.
 */
export async function getMultiCurrencyTotal(
  orgId: string,
  fxService: FxRateService,
): Promise<MultiCurrencyTotal> {
  return withTenantContext(orgId, async (tx) => {
    // Fetch the org's base currency in the same tenant context
    const [tenant] = await tx
      .select({ baseCurrency: tenants.baseCurrency })
      .from(tenants)
      .where(eq(tenants.id, orgId))
      .limit(1);

    const displayCurrency = tenant?.baseCurrency ?? "EUR";

    const balances = await tx
      .select({
        currency: orgCurrencyBalances.currency,
        clearedTotalCents: orgCurrencyBalances.clearedTotalCents,
      })
      .from(orgCurrencyBalances)
      .where(eq(orgCurrencyBalances.orgId, orgId));

    let totalDisplayCents = 0;
    let latestTimestamp: string | null = null;

    for (const balance of balances) {
      const cleared = Number(balance.clearedTotalCents ?? 0);
      if (cleared === 0) continue;

      const lookup = await fxService.getRate(balance.currency, displayCurrency);
      if (lookup.rate !== null) {
        totalDisplayCents += Math.round(cleared * lookup.rate);
        if (lookup.timestamp !== null && latestTimestamp === null) {
          latestTimestamp = lookup.timestamp.toISOString();
        }
      }
      // If rate is null (cache cold / Fixer.io down), skip that currency's
      // contribution rather than failing the whole dashboard response.
    }

    return { totalDisplayCents, displayCurrency, exchangeRateTimestamp: latestTimestamp };
  });
}
