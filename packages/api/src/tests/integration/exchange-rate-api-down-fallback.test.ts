/**
 * Exchange-rate API down / fallback regression tests (P2 — issue #230).
 *
 * Verifies the fallback cascade when the exchangerate-api.com endpoint is
 * unavailable: the service must use `local_fallback` (most recent DB row)
 * rather than silently returning `default_fallback` rate=1 which would corrupt
 * amountBaseCents.
 *
 * These tests do NOT require P0/P1 schema changes — ExchangeRateService on
 * main already supports the `local_fallback` and `default_fallback` sources.
 */

import { clearExchangeRateApiCache, ExchangeRateService } from "@givernance/shared";
import { exchangeRates } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Fetch stub that always rejects — simulates API down */
const fetchAlwaysFails: typeof fetch = () =>
  Promise.reject(new Error("ECONNREFUSED: exchangerate-api.com is down"));

beforeAll(async () => {
  // Seed a known rate for EUR→CHF on yesterday so local_fallback has data
  await db
    .insert(exchangeRates)
    .values({
      currency: "EUR",
      baseCurrency: "CHF",
      date: YESTERDAY,
      rate: "0.95000000",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM exchange_rates WHERE currency = 'EUR' AND base_currency = 'CHF' AND date = ${YESTERDAY}`,
  );
});

beforeEach(() => {
  clearExchangeRateApiCache();
});

describe("P2: ExchangeRateService fallback when API is down", () => {
  it("returns local_fallback when API call fails and a prior rate exists in DB", async () => {
    const svc = new ExchangeRateService({
      apiKey: "test-key",
      dbClient: db,
      fetchImpl: fetchAlwaysFails,
      logger: { warn: vi.fn() },
    });
    const result = await svc.getRate("EUR", "CHF");
    expect(result.source).toBe("local_fallback");
    expect(result.rate).toBeCloseTo(0.95, 4);
  });

  it("returns default_fallback (rate=1) when API fails and no DB row exists", async () => {
    const warnSpy = vi.fn();
    const svc = new ExchangeRateService({
      apiKey: "test-key",
      dbClient: db,
      fetchImpl: fetchAlwaysFails,
      logger: { warn: warnSpy },
    });
    // Use an obscure pair with no local data
    const result = await svc.getRate("CZK", "PLN");
    expect(result.source).toBe("default_fallback");
    expect(result.rate).toBe(1);
    // Warn must be emitted — default_fallback is a production signal
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns same_currency without hitting API", async () => {
    const svc = new ExchangeRateService({
      apiKey: "test-key",
      dbClient: db,
      fetchImpl: fetchAlwaysFails,
      logger: { warn: vi.fn() },
    });
    const result = await svc.getRate("EUR", "EUR");
    expect(result.source).toBe("same_currency");
    expect(result.rate).toBe(1);
  });
});
