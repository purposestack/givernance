import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../schema/index.js";
import { exchangeRates, tenants } from "../schema/index.js";

type DbClient = Pick<NodePgDatabase<typeof schema>, "select" | "insert">;

interface ExchangeRateApiResponse {
  conversion_rates?: Record<string, number>;
}

export interface ExchangeRateLookup {
  rate: number;
  source:
    | "same_currency"
    | "local_exact"
    | "api"
    | "api_cache"
    | "local_fallback"
    | "default_fallback";
}

interface ExchangeRateCacheEntry {
  expiresAt: number;
  rate: number | null;
}

/**
 * Injectable Redis-backed cache so multiple API/worker processes share the same
 * rate data instead of each keeping a separate in-process Map.
 * The shared package must not import ioredis directly (ADR-013 type boundary);
 * the caller (API or worker) wires in the concrete Redis commands.
 */
export interface ExchangeRateCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface ExchangeRateServiceOptions {
  apiKey?: string;
  cache?: ExchangeRateCache;
  cacheTtlMs?: number;
  dbClient: DbClient;
  fetchImpl?: typeof fetch;
  logger?: { warn: (...args: unknown[]) => void };
  timeoutMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2_000;
/** Process-local fallback cache — used only when no Redis cache is injected */
const exchangeRateApiCache = new Map<string, ExchangeRateCacheEntry>();

const REDIS_CACHE_TTL_SECONDS = 3600;

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

function getCacheKey(source: string, target: string, date: string) {
  return `${source}:${target}:${date}`;
}

function readCachedRate(source: string, target: string, date: string) {
  const cacheKey = getCacheKey(source, target, date);
  const cached = exchangeRateApiCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    exchangeRateApiCache.delete(cacheKey);
    return null;
  }

  return cached;
}

async function getBaseCurrency(dbClient: DbClient, orgId: string) {
  const [tenant] = await dbClient
    .select({ baseCurrency: tenants.baseCurrency })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  return normalizeCurrency(tenant?.baseCurrency ?? "EUR");
}

export function clearExchangeRateApiCache() {
  exchangeRateApiCache.clear();
}

export class ExchangeRateService {
  private readonly apiKey?: string;
  private readonly redisCache?: ExchangeRateCache;
  private readonly cacheTtlMs: number;
  private readonly dbClient: DbClient;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: { warn: (...args: unknown[]) => void };
  private readonly timeoutMs: number;

  constructor(options: ExchangeRateServiceOptions) {
    this.apiKey = options.apiKey;
    this.redisCache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.dbClient = options.dbClient;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

    // Redis cache wins over the in-process Map when available
    if (this.redisCache) {
      const redisKey = `fx:${source}:${target}:${date}`;
      const redisHit = await this.redisCache.get(redisKey);
      if (redisHit) {
        const redisRate = parseRate(redisHit);
        if (redisRate) return { rate: redisRate, source: "api_cache" };
      }
    }

    const cachedRate = this.redisCache ? null : readCachedRate(source, target, date);
    if (cachedRate?.rate) {
      return { rate: cachedRate.rate, source: "api_cache" };
    }

    const apiRate = cachedRate ? null : await this.fetchAndStoreRate(source, target, date);
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
    if (!this.apiKey) {
      this.logger.warn(
        { sourceCurrency: source, targetCurrency: target },
        "exchange_rate.api_key_missing_skipping_remote_fetch",
      );
      return null;
    }

    try {
      const response = await this.fetchImpl(
        `https://v6.exchangerate-api.com/v6/${this.apiKey}/latest/${source}`,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
        },
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
          target: [exchangeRates.currency, exchangeRates.baseCurrency, exchangeRates.date],
          set: {
            rate: toStoredRate(rate),
            updatedAt: new Date(),
          },
        });

      if (this.redisCache) {
        const redisKey = `fx:${source}:${target}:${date}`;
        await this.redisCache
          .set(redisKey, toStoredRate(rate), REDIS_CACHE_TTL_SECONDS)
          .catch(() => {
            /* non-fatal: Redis write failure degrades to DB lookup next request */
          });
      } else {
        exchangeRateApiCache.set(getCacheKey(source, target, date), {
          expiresAt: Date.now() + this.cacheTtlMs,
          rate,
        });
      }

      return rate;
    } catch (error) {
      if (!this.redisCache) {
        exchangeRateApiCache.set(getCacheKey(source, target, date), {
          expiresAt: Date.now() + this.cacheTtlMs,
          rate: null,
        });
      }

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
