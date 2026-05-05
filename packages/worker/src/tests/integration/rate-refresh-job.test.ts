/**
 * Rate-refresh nightly job regression tests (P2 — issue #230).
 *
 * Verifies the BullMQ CRON processor `processRefreshExchangeRates` (P1).
 * These tests depend on the P1 processor and the separate Redis cache
 * connection (packages/worker/src/lib/cache-redis.ts).
 *
 * Note: the processor is added in P1. Tests below marked `it.todo` become
 * active once P1 (feat/multi-currency-p1-robustness-ux) is merged to main
 * and this branch is rebased.
 */

import { exchangeRates } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";

const ORG_REFRESH = "00000000-0000-0000-0000-000000002320";
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  // Seed a tenant and a donation pair so the refresh job has something to query
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${ORG_REFRESH}, 'Rate Refresh Test Org', 'rate-refresh-test', 'EUR')
        ON CONFLICT (id) DO UPDATE SET base_currency = 'EUR'`,
  );

  // Seed a constituent and a GBP donation (GBP→EUR pair for the refresh job)
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_REFRESH}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_REFRESH}`);
  await db.execute(sql`
    INSERT INTO constituents (org_id, first_name, last_name, type)
    VALUES (${ORG_REFRESH}, 'Rate', 'Refresh', 'donor')
  `);
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT id FROM constituents WHERE org_id = ${ORG_REFRESH} LIMIT 1`,
  );
  const constituentId = rows[0]?.id;
  if (!constituentId) return;

  await db.execute(sql`
    INSERT INTO donations (org_id, constituent_id, amount_cents, currency, exchange_rate, amount_base_cents, donated_at)
    VALUES (${ORG_REFRESH}, ${constituentId}, 5000, 'GBP', 1.15000000, 5750,
            NOW() - INTERVAL '7 days')
  `);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_REFRESH}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_REFRESH}`);
  await db.execute(
    sql`DELETE FROM exchange_rates WHERE currency = 'GBP' AND base_currency = 'EUR' AND date = ${TODAY}`,
  );
});

describe("P2: rate-refresh nightly job", () => {
  it.todo("processRefreshExchangeRates populates exchange_rates for active pairs (requires P1)");

  it.todo("refresh job skips parity pairs — EUR→EUR not fetched (requires P1)");

  it.todo("per-pair error is swallowed; job succeeds overall (requires P1)");

  it.todo("refresh job emits exchange_rate.refresh_complete log with pair counts (requires P1)");

  it("exchange_rates table accepts GBP→EUR rate (schema validation)", async () => {
    // Tests that the DB column types and constraints are valid, independently of the job
    await db
      .insert(exchangeRates)
      .values({
        currency: "GBP",
        baseCurrency: "EUR",
        date: TODAY,
        rate: "1.18000000",
      })
      .onConflictDoNothing();

    const { rows } = await db.execute<{ rate: string }>(
      sql`SELECT rate FROM exchange_rates WHERE currency = 'GBP' AND base_currency = 'EUR' AND date = ${TODAY}`,
    );
    expect(rows[0]?.rate).toBeTruthy();
  });
});
