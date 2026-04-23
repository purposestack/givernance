import { exchangeRates } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { ExchangeRateService } from "./exchange-rate-service.js";

const ORG_ID = "00000000-0000-0000-0000-000000000125";

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${ORG_ID}, 'Exchange Rate Org', 'exchange-rate-org', 'CHF')
        ON CONFLICT (id) DO UPDATE SET base_currency = 'CHF'`,
  );
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM exchange_rates WHERE currency IN ('EUR', 'USD')`);
});

describe("ExchangeRateService", () => {
  it("returns the tenant base currency", async () => {
    await withTenantContext(ORG_ID, async (tx) => {
      const service = new ExchangeRateService({ dbClient: tx });
      await expect(service.getOrgBaseCurrency(ORG_ID)).resolves.toBe("CHF");
    });
  });

  it("stores and returns a remote rate when no local rate exists", async () => {
    process.env.EXCHANGE_RATE_API_KEY = "test-key";
    await db.delete(exchangeRates).where(
      and(eq(exchangeRates.currency, "EUR"), eq(exchangeRates.baseCurrency, "CHF")),
    );

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          conversion_rates: {
            CHF: 0.95,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await withTenantContext(ORG_ID, async (tx) => {
      const service = new ExchangeRateService({ dbClient: tx, fetchImpl });
      const lookup = await service.getRate("EUR", "CHF");

      expect(lookup.rate).toBe(0.95);
      expect(lookup.source).toBe("api");
    });

    const [stored] = await db
      .select({ rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.currency, "EUR"), eq(exchangeRates.baseCurrency, "CHF")))
      .limit(1);

    expect(Number(stored?.rate)).toBe(0.95);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the latest local rate when the remote call fails", async () => {
    process.env.EXCHANGE_RATE_API_KEY = "test-key";
    await db.delete(exchangeRates).where(
      and(eq(exchangeRates.currency, "USD"), eq(exchangeRates.baseCurrency, "CHF")),
    );

    await db
      .insert(exchangeRates)
      .values({
        currency: "USD",
        baseCurrency: "CHF",
        rate: "0.88000000",
        date: "2026-04-22",
      })
      .onConflictDoUpdate({
        target: [exchangeRates.currency, exchangeRates.baseCurrency, exchangeRates.date],
        set: { rate: "0.88000000", updatedAt: new Date() },
      });

    const warn = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("boom"));

    await withTenantContext(ORG_ID, async (tx) => {
      const service = new ExchangeRateService({
        dbClient: tx,
        fetchImpl,
        logger: { warn },
      });
      const lookup = await service.getRate("USD", "CHF");

      expect(lookup.rate).toBe(0.88);
      expect(lookup.source).toBe("local_fallback");
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
