/**
 * FxRateService — Fixer.io-backed exchange rate lookup with Redis cache.
 *
 * ADR-031 §2.1: Fixer.io as exchange rate provider, Redis cache with 25h TTL.
 * ADR-031 §1.4: FX resilience — returns rate: null (fx_pending fallback) when
 * Fixer.io is down.
 *
 * Cache key strategy: fx:rates:{fromCurrency} → JSON { rates: Record<string, number>, timestamp: string }
 * TTL: 90 000 seconds (25 hours).
 *
 * Worker job (refresh_fx_cache) populates the cache via fetchAndCache().
 * Checkout and donation routes call getRate() which reads from cache; on cache
 * miss it falls back to a live Fixer.io call and populates the cache entry.
 *
 * Epic #416 Task 9.
 */

/** ioredis subset needed by FxRateService — avoids a direct ioredis import in packages/shared */
export interface FxRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", time: number): Promise<"OK" | null>;
}

export interface FxRateResult {
  /** Converted rate (fromCurrency → toCurrency). null when Fixer.io is unavailable. */
  rate: number | null;
  /** "same_currency" | "fixer_cache" (Redis hit) | "fixer_api" (live call) */
  source: "fixer_api" | "fixer_cache" | "same_currency";
  /** ISO 8601 timestamp from Fixer.io response, or null for same-currency / cache-miss failures. */
  timestamp: Date | null;
}

export interface FxRateServiceOptions {
  /** FIXER_API_KEY. When absent, live calls are skipped and cache-only is used. */
  apiKey?: string;
  /** Injected ioredis (or compatible) client. */
  redis: FxRedisClient;
  /** Override for unit tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Logger. Defaults to console. */
  logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

/** Fixer.io /api/latest or /api/{date} response shape. */
interface FixerResponse {
  success: boolean;
  timestamp?: number;
  base?: string;
  rates?: Record<string, number>;
  error?: { code: number; info: string };
}

/** Redis key for a base currency's rate set (TTL 90 000 s / 25 h). */
function redisKey(baseCurrency: string): string {
  return `fx:rates:${baseCurrency.toUpperCase()}`;
}

/** Payload stored in Redis. */
interface CachedRatePayload {
  rates: Record<string, number>;
  /** ISO 8601 string from Fixer.io `timestamp` epoch. */
  timestamp: string;
}

const REDIS_TTL_SECONDS = 90_000;
const FIXER_BASE_URL = "https://data.fixer.io/api";

export class FxRateService {
  private readonly apiKey?: string;
  private readonly redis: FxRedisClient;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: {
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };

  constructor(options: FxRateServiceOptions) {
    this.apiKey = options.apiKey;
    this.redis = options.redis;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
  }

  /**
   * Get the conversion rate from `fromCurrency` to `toCurrency`.
   *
   * Resolution order:
   *   1. Same-currency short-circuit → { rate: 1.0, source: "same_currency" }
   *   2. Redis cache hit (key fx:rates:{fromCurrency}) → { rate, source: "fixer_cache" }
   *   3. Live Fixer.io call + cache population → { rate, source: "fixer_api" }
   *   4. Fixer.io unavailable → { rate: null, source: "fixer_cache" }
   *      (caller must set fx_pending = true per ADR-031 §1.4)
   */
  async getRate(fromCurrency: string, toCurrency: string): Promise<FxRateResult> {
    const from = fromCurrency.trim().toUpperCase();
    const to = toCurrency.trim().toUpperCase();

    if (from === to) {
      return { rate: 1.0, source: "same_currency", timestamp: null };
    }

    // 1. Try Redis cache
    const cached = await this.readCache(from);
    if (cached !== null) {
      const rate = cached.rates[to] ?? null;
      if (rate !== null) {
        return {
          rate,
          source: "fixer_cache",
          timestamp: new Date(cached.timestamp),
        };
      }
      // Cache hit but target currency missing — fall through to live call
      this.logger.warn(
        { fromCurrency: from, toCurrency: to },
        "fx_rate.cache_hit_but_target_missing",
      );
    }

    // 2. Live Fixer.io call
    if (!this.apiKey) {
      this.logger.warn(
        { fromCurrency: from, toCurrency: to },
        "fx_rate.api_key_missing_skipping_remote_fetch",
      );
      return { rate: null, source: "fixer_cache", timestamp: null };
    }

    try {
      const fetched = await this.callFixerLatest(from);
      if (fetched === null) {
        return { rate: null, source: "fixer_cache", timestamp: null };
      }
      // Store full rate set in cache
      await this.writeCache(from, fetched);
      const rate = fetched.rates[to] ?? null;
      if (rate === null) {
        this.logger.warn(
          { fromCurrency: from, toCurrency: to },
          "fx_rate.fixer_response_missing_target_currency",
        );
        return { rate: null, source: "fixer_api", timestamp: new Date(fetched.timestamp) };
      }
      return { rate, source: "fixer_api", timestamp: new Date(fetched.timestamp) };
    } catch (err) {
      this.logger.warn(
        {
          fromCurrency: from,
          toCurrency: to,
          err: err instanceof Error ? err.message : String(err),
        },
        "fx_rate.remote_fetch_failed",
      );
      return { rate: null, source: "fixer_cache", timestamp: null };
    }
  }

  /**
   * Fetch all rates for `baseCurrency` from Fixer.io and store them in Redis.
   *
   * Called by the `refresh_fx_cache` worker job.
   *
   * @returns { pairsLoaded: number } — number of target-currency pairs stored.
   * @throws when Fixer.io is unavailable (caller catches and logs).
   */
  async fetchAndCache(baseCurrency: string): Promise<{ pairsLoaded: number }> {
    const base = baseCurrency.trim().toUpperCase();

    if (!this.apiKey) {
      throw new Error(`fx_rate.fetchAndCache: FIXER_API_KEY not set — cannot refresh ${base}`);
    }

    const fetched = await this.callFixerLatest(base);
    if (fetched === null) {
      throw new Error(`fx_rate.fetchAndCache: Fixer.io returned failure response for base ${base}`);
    }

    await this.writeCache(base, fetched);
    const pairsLoaded = Object.keys(fetched.rates).length;

    this.logger.info(
      { baseCurrency: base, pairsLoaded, timestamp: fetched.timestamp },
      "fx_rate.cache_populated",
    );

    return { pairsLoaded };
  }

  /**
   * Fetch the Fixer.io /api/latest endpoint for `baseCurrency`.
   * Returns null on API-level failure (success: false).
   * Throws on network/HTTP errors — caller handles.
   */
  private async callFixerLatest(
    baseCurrency: string,
  ): Promise<{ rates: Record<string, number>; timestamp: string } | null> {
    const url = `${FIXER_BASE_URL}/latest?access_key=${this.apiKey}&base=${baseCurrency}`;
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`Fixer.io HTTP ${response.status} for base ${baseCurrency}`);
    }

    const payload = (await response.json()) as FixerResponse;

    if (!payload.success || !payload.rates) {
      this.logger.warn({ baseCurrency, error: payload.error }, "fx_rate.fixer_api_error_response");
      return null;
    }

    const timestamp = payload.timestamp
      ? new Date(payload.timestamp * 1000).toISOString()
      : new Date().toISOString();

    return { rates: payload.rates, timestamp };
  }

  /** Read and parse the Redis cache entry for `baseCurrency`. Returns null on miss/parse error. */
  private async readCache(baseCurrency: string): Promise<CachedRatePayload | null> {
    try {
      const raw = await this.redis.get(redisKey(baseCurrency));
      if (raw === null) return null;
      return JSON.parse(raw) as CachedRatePayload;
    } catch {
      return null;
    }
  }

  /** Serialize and write the rate set to Redis with the configured TTL. */
  private async writeCache(
    baseCurrency: string,
    payload: { rates: Record<string, number>; timestamp: string },
  ): Promise<void> {
    const value: CachedRatePayload = { rates: payload.rates, timestamp: payload.timestamp };
    await this.redis.set(redisKey(baseCurrency), JSON.stringify(value), "EX", REDIS_TTL_SECONDS);
  }
}
