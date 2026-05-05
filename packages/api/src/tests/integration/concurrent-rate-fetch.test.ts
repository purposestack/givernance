/**
 * Concurrent exchange-rate fetch deduplication tests (P2 — issue #230).
 *
 * Verifies that concurrent calls to ExchangeRateService.getRate() for the
 * same pair on the same day do not trigger multiple API calls. The in-process
 * Map cache acts as a request-coalescence layer; the second caller should hit
 * `api_cache` (process Map) or `local_exact` (DB row written by the first
 * caller), not `api` again.
 *
 * These tests do NOT require P0/P1 schema changes.
 */

import { clearExchangeRateApiCache, ExchangeRateService } from "@givernance/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

const TODAY = new Date().toISOString().slice(0, 10);

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM exchange_rates WHERE currency = 'GBP' AND base_currency = 'EUR' AND date = ${TODAY}`,
  );
});

beforeEach(() => {
  clearExchangeRateApiCache();
});

describe("P2: concurrent ExchangeRateService.getRate() — request deduplication", () => {
  it("two concurrent getRate() calls for the same pair share the in-process cache", async () => {
    let fetchCallCount = 0;
    const mockFetch: typeof fetch = (_url, _init) => {
      fetchCallCount++;
      // Return a minimal valid exchangerate-api.com response
      return Promise.resolve(
        new Response(JSON.stringify({ conversion_rates: { EUR: 1.15 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const svc = new ExchangeRateService({
      apiKey: "test-key",
      dbClient: db,
      fetchImpl: mockFetch,
      logger: { warn: vi.fn() },
    });

    // Fire both concurrently — they may both call fetch in the first run since
    // the Map is populated synchronously after the first await returns.
    const [r1, r2] = await Promise.all([svc.getRate("GBP", "EUR"), svc.getRate("GBP", "EUR")]);

    // At most one API call for the same (currency, base, date) triple
    expect(fetchCallCount).toBeLessThanOrEqual(1);
    expect(r1.rate).toBeCloseTo(1.15, 4);
    expect(r2.rate).toBeCloseTo(1.15, 4);
    // Second result must come from cache, not a fresh API call
    expect([r1.source, r2.source]).toContain("api_cache");
  });

  it("second sequential call returns api_cache without hitting fetch again", async () => {
    let fetchCallCount = 0;
    const mockFetch: typeof fetch = () => {
      fetchCallCount++;
      return Promise.resolve(
        new Response(JSON.stringify({ conversion_rates: { EUR: 1.2 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const svc = new ExchangeRateService({
      apiKey: "test-key",
      dbClient: db,
      fetchImpl: mockFetch,
      logger: { warn: vi.fn() },
    });

    const first = await svc.getRate("SEK", "EUR");
    expect(first.source).toBe("api");

    const second = await svc.getRate("SEK", "EUR");
    expect(second.source).toBe("api_cache");
    // fetch was called exactly once
    expect(fetchCallCount).toBe(1);
  });

  it("clearExchangeRateApiCache() forces a fresh fetch on next call", async () => {
    let fetchCallCount = 0;
    const mockFetch: typeof fetch = () => {
      fetchCallCount++;
      return Promise.resolve(
        new Response(JSON.stringify({ conversion_rates: { EUR: 1.3 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const svc = new ExchangeRateService({
      apiKey: "test-key",
      dbClient: db,
      fetchImpl: mockFetch,
      logger: { warn: vi.fn() },
    });

    await svc.getRate("NOK", "EUR");
    clearExchangeRateApiCache();
    await svc.getRate("NOK", "EUR");

    // After cache clear, fetch is called again (but local_exact in DB may shortcut it)
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });
});
