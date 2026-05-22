/**
 * org_currency_balances smoke tests (Epic #416, Task 6).
 *
 * The `org_currency_balances` table tracks running cleared/pending totals
 * per (org_id, currency). The worker processor does the upserts; this
 * suite just verifies the schema is correct and RLS isolates tenants.
 *
 * Worker-side upsert logic is hard to integration-test without mocking
 * BullMQ — this file focuses on:
 *   1. The table exists and columns have the expected structure
 *   2. A direct INSERT + SELECT within withTenantContext works (RLS passes)
 *   3. ORG_B cannot read ORG_A rows via withTenantContext (RLS isolation)
 */

import { orgCurrencyBalances } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { ensureTestTenants, ORG_A, ORG_B } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Clean up any leftover test rows from prior runs
  await db.execute(sql`DELETE FROM org_currency_balances WHERE org_id IN (${ORG_A}, ${ORG_B})`);
});

afterAll(async () => {
  // Clean up test rows so re-runs start clean
  await db.execute(sql`DELETE FROM org_currency_balances WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await app.close();
});

describe("org_currency_balances schema + RLS (Epic #416 Task 6)", () => {
  it("direct INSERT via db.execute succeeds (owner role bypasses RLS)", async () => {
    // The owner-role db instance bypasses RLS — we use raw sql to simulate
    // what the worker upsert would do.
    await db.execute(sql`
      INSERT INTO org_currency_balances (org_id, currency, cleared_total_cents, pending_total_cents)
      VALUES (${ORG_A}, 'CHF', 10000, 500)
      ON CONFLICT (org_id, currency) DO UPDATE
        SET cleared_total_cents = EXCLUDED.cleared_total_cents,
            pending_total_cents = EXCLUDED.pending_total_cents,
            updated_at = NOW()
    `);

    // No error → INSERT succeeded
  });

  it("SELECT via withTenantContext (ORG_A) sees its own row", async () => {
    const rows = await withTenantContext(ORG_A, async (tx) => {
      return tx
        .select()
        .from(orgCurrencyBalances)
        .where(and(eq(orgCurrencyBalances.orgId, ORG_A), eq(orgCurrencyBalances.currency, "CHF")));
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(ORG_A);
    expect(rows[0]?.currency).toBe("CHF");
    expect(rows[0]?.clearedTotalCents).toBe(10000);
    expect(rows[0]?.pendingTotalCents).toBe(500);
  });

  it("INSERT a row for ORG_B and verify it is isolated from ORG_A context", async () => {
    await db.execute(sql`
      INSERT INTO org_currency_balances (org_id, currency, cleared_total_cents, pending_total_cents)
      VALUES (${ORG_B}, 'EUR', 20000, 0)
      ON CONFLICT (org_id, currency) DO UPDATE
        SET cleared_total_cents = EXCLUDED.cleared_total_cents,
            pending_total_cents = EXCLUDED.pending_total_cents,
            updated_at = NOW()
    `);

    // ORG_A tenant context should NOT see ORG_B rows
    const rowsFromOrgAContext = await withTenantContext(ORG_A, async (tx) => {
      return tx.select().from(orgCurrencyBalances).where(eq(orgCurrencyBalances.orgId, ORG_B));
    });

    // RLS policy filters org_id = current_setting('app.current_organization_id')::uuid
    // so ORG_B rows are invisible when the context is ORG_A
    expect(rowsFromOrgAContext).toHaveLength(0);
  });

  it("ORG_B tenant context sees its own rows", async () => {
    const rows = await withTenantContext(ORG_B, async (tx) => {
      return tx
        .select()
        .from(orgCurrencyBalances)
        .where(and(eq(orgCurrencyBalances.orgId, ORG_B), eq(orgCurrencyBalances.currency, "EUR")));
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(ORG_B);
    expect(rows[0]?.clearedTotalCents).toBe(20000);
  });

  it("row has updatedAt column populated automatically", async () => {
    const rows = await withTenantContext(ORG_A, async (tx) => {
      return tx
        .select({ updatedAt: orgCurrencyBalances.updatedAt })
        .from(orgCurrencyBalances)
        .where(eq(orgCurrencyBalances.orgId, ORG_A));
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
