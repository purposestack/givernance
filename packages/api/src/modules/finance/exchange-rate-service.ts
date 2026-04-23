import { exchangeRates, tenants } from "@givernance/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import pino from "pino";
import { env } from "../../env.js";
import { db } from "../../lib/db.js";

type DbClient = Pick<typeof db, "select" | "insert">;

interface ExchangeRateApiResponse {
  conversion_rates?: Record<string, number>;
}

export interface ExchangeRateLookup {
  rate: number;
  source: "same_currency" | "local_exact" | "api" | "local_fallback" | "default_fallback";
}

interface ExchangeRateServiceOptions {
  dbClient?: DbClient;
  fetchImpl?: typeof fetch;
  logger?: { warn: (...args: unknown[]) => void };
}

const exchangeRateLogger = pino({
  level: env.LOG_LEVEL,
  base: { service: "givernance-api", module: "exchange-rate-service" },
});

function normalizeCurrency(currency: string) {
  return currency.trim().toUpperCase();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseRate(value: string | number | null | undefined) {
  const rate = typeof value === "number" ? value : Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function toStoredRate(rate: number) {
  return rate.toFixed(8);
}

async function getBaseCurrency(dbClient: DbClient, orgId: string) {
  const [tenant] = await dbClient
    .select({ baseCurrency: tenants.baseCurrency })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  return normalizeCurrency(tenant?.baseCurrency ?? "EUR");
}

export class ExchangeRateService {
  private readonly dbClient: DbClient;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: { warn: (...args: unknown[]) => void };

  constructor(options: ExchangeRateServiceOptions = {}) {
    this.dbClient = options.dbClient ?? db;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? exchangeRateLogger;
  }

  async getOrgBaseCurrency(orgId: string) {
    return getBaseCurrency(this.dbClient, orgId);
  }

  async getRate(sourceCurrency: string, targetCurrency: string): Promise<ExchangeRateLookup> {
    const source = normalizeCurrency(sourceCurrency);
    const target = normalizeCurrency(targetCurrency);

    if (source === target) {
      return { rate: 1, source: "same_currency" };
    }

    const date = todayIsoDate();
    const [exactRate] = await this.dbClient
      .select({ rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.currency, source),
          eq(exchangeRates.baseCurrency, target),
          eq(exchangeRates.date, date),
        ),
      )
      .limit(1);

    const localRate = parseRate(exactRate?.rate);
    if (localRate) {
      return { rate: localRate, source: "local_exact" };
    }

    const apiRate = await this.fetchAndStoreRate(source, target, date);
    if (apiRate) {
      return { rate: apiRate, source: "api" };
    }

    const [latestKnownRate] = await this.dbClient
      .select({ rate: exchangeRates.rate, date: exchangeRates.date })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.currency, source), eq(exchangeRates.baseCurrency, target)))
      .orderBy(desc(exchangeRates.date), desc(exchangeRates.updatedAt))
      .limit(1);

    const fallbackRate = parseRate(latestKnownRate?.rate);
    if (fallbackRate) {
      this.logger.warn(
        {
          sourceCurrency: source,
          targetCurrency: target,
          fallbackRate,
          fallbackDate: latestKnownRate?.date ?? null,
        },
        "exchange_rate.api_failed_using_latest_local_rate",
      );
      return { rate: fallbackRate, source: "local_fallback" };
    }

    this.logger.warn(
      { sourceCurrency: source, targetCurrency: target },
      "exchange_rate.no_rate_available_defaulting_to_1",
    );
    return { rate: 1, source: "default_fallback" };
  }

  async convertAmountCents(amountCents: number, sourceCurrency: string, targetCurrency: string) {
    const lookup = await this.getRate(sourceCurrency, targetCurrency);
    return {
      exchangeRate: lookup.rate,
      amountBaseCents: Math.round(amountCents * lookup.rate),
      source: lookup.source,
    };
  }

  private async fetchAndStoreRate(source: string, target: string, date: string) {
    const apiKey = process.env.EXCHANGE_RATE_API_KEY ?? env.EXCHANGE_RATE_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        { sourceCurrency: source, targetCurrency: target },
        "exchange_rate.api_key_missing_skipping_remote_fetch",
      );
      return null;
    }

    try {
      const response = await this.fetchImpl(
        `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${source}`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as ExchangeRateApiResponse;
      const rate = parseRate(payload.conversion_rates?.[target]);

      if (!rate) {
        throw new Error(`Missing conversion rate for ${target}`);
      }

      await this.dbClient
        .insert(exchangeRates)
        .values({
          currency: source,
          baseCurrency: target,
          rate: toStoredRate(rate),
          date,
        })
        .onConflictDoUpdate({
          target: [
            exchangeRates.currency,
            exchangeRates.baseCurrency,
            exchangeRates.date,
          ],
          set: {
            rate: toStoredRate(rate),
            updatedAt: new Date(),
          },
        });

      return rate;
    } catch (error) {
      this.logger.warn(
        {
          sourceCurrency: source,
          targetCurrency: target,
          err: error instanceof Error ? error.message : String(error),
        },
        "exchange_rate.remote_fetch_failed",
      );
      return null;
    }
  }
}
