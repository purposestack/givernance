/** Job processor — nightly exchange-rate refresh */

import { ExchangeRateService } from "@givernance/shared";
import { donations, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, gte, ne } from "drizzle-orm";
import { env } from "../env.js";
import { exchangeRateRedisCache } from "../lib/cache-redis.js";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/**
 * Refresh exchange rates for all (donation_currency, tenant_base_currency)
 * pairs active in the last 90 days.
 *
 * Runs nightly at 02:00 UTC so the DB always has a fresh rate available before
 * the European business day starts, reducing reliance on the real-time API
 * fallback during donation processing.
 *
 * Error handling: per-pair failures are logged and swallowed — one bad currency
 * pair should not abort the entire refresh. The job itself succeeds if it
 * completes iteration.
 */
export async function processRefreshExchangeRates(job: Job): Promise<void> {
  const log = jobLogger({ jobId: job.id, traceId: "exchange-rate-refresh" });

  log.info("exchange_rate.refresh_start");

  // Collect distinct (donation_currency, tenant_base_currency) pairs from
  // donations in the last 90 days. We join through donations → tenants to get
  // the tenant's current base currency as the pivot.
  // NOTE: Once P0 lands and donations gain a `baseCurrencyAtDonation` snapshot
  // column, this query should switch to that field for historical accuracy.
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const pairs = await db
    .selectDistinct({
      currency: donations.currency,
      baseCurrency: tenants.baseCurrency,
    })
    .from(donations)
    .innerJoin(tenants, eq(donations.orgId, tenants.id))
    .where(
      and(
        gte(donations.donatedAt, since),
        ne(donations.currency, tenants.baseCurrency),
      ),
    );

  log.info({ pairCount: pairs.length }, "exchange_rate.refresh_pairs_found");

  const exchangeRateService = new ExchangeRateService({
    apiKey: env.EXCHANGE_RATE_API_KEY,
    dbClient: db,
    cache: exchangeRateRedisCache,
    logger: log,
  });

  let refreshed = 0;
  let failed = 0;

  for (const { currency, baseCurrency } of pairs) {
    try {
      await exchangeRateService.getRate(currency, baseCurrency);
      refreshed++;
    } catch (err) {
      failed++;
      log.warn(
        {
          currency,
          baseCurrency,
          err: err instanceof Error ? err.message : String(err),
        },
        "exchange_rate.refresh_failed_pair",
      );
    }
  }

  log.info({ refreshed, failed, total: pairs.length }, "exchange_rate.refresh_complete");
}
