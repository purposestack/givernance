/**
 * Constituent-count refresh — Epic #434, issue #436.
 *
 * Validates that the daily cron updates `tenants.constituent_count_cached`
 * for every non-archived tenant, scoped per-tenant (so a future RLS
 * scope confusion doesn't fan out across tenants).
 */

import { randomUUID } from "node:crypto";
import { featureFlags, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { processConstituentCountRefresh } from "../../processors/finance-constituent-count-refresh.js";

const TENANT_EMPTY = "00000000-0000-0000-0000-000000000436";
const TENANT_WITH_THREE = "00000000-0000-0000-0000-000000000437";
const TENANT_ARCHIVED = "00000000-0000-0000-0000-000000000438";

function mockJob(): Job {
  return { id: "test-cc-refresh", data: {}, name: "test" } as unknown as Job;
}

beforeAll(async () => {
  // Ensure the feature flag is on for these tests (the cron is a no-op
  // when off). Restore default-off in afterAll.
  await db
    .insert(featureFlags)
    .values({
      key: "admin.finance_dashboard",
      enabled: true,
      label: "finance",
      description: "finance",
      scope: "platform",
      public: true,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true },
    });

  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES
      (${TENANT_EMPTY}, 'Empty NPO', 'empty-npo-436', 'active'),
      (${TENANT_WITH_THREE}, 'Three-Donor NPO', 'three-donor-npo-436', 'active'),
      (${TENANT_ARCHIVED}, 'Archived NPO', 'archived-npo-436', 'archived')
    ON CONFLICT (id) DO UPDATE
      SET status = EXCLUDED.status, constituent_count_cached = 0, constituent_count_refreshed_at = NULL
  `);

  // Seed three live constituents in TENANT_WITH_THREE + one soft-deleted
  // (must be excluded from the count).
  for (let i = 0; i < 3; i += 1) {
    await db.execute(
      sql`INSERT INTO constituents (id, org_id, first_name, last_name, type)
          VALUES (${randomUUID()}, ${TENANT_WITH_THREE}, 'Donor', ${`Live ${i}`}, 'donor')`,
    );
  }
  await db.execute(
    sql`INSERT INTO constituents (id, org_id, first_name, last_name, type, deleted_at)
        VALUES (${randomUUID()}, ${TENANT_WITH_THREE}, 'Donor', 'Soft-Deleted', 'donor', NOW())`,
  );
});

beforeEach(async () => {
  // Reset cached counts so we can observe the refresh's writes
  // independently each test.
  await db
    .update(tenants)
    .set({ constituentCountCached: 0, constituentCountRefreshedAt: null })
    .where(sql`id IN (${TENANT_EMPTY}, ${TENANT_WITH_THREE}, ${TENANT_ARCHIVED})`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${TENANT_WITH_THREE})`);
  await db.execute(
    sql`DELETE FROM tenants WHERE id IN (${TENANT_EMPTY}, ${TENANT_WITH_THREE}, ${TENANT_ARCHIVED})`,
  );
  await db
    .update(featureFlags)
    .set({ enabled: false })
    .where(eq(featureFlags.key, "admin.finance_dashboard"));
});

describe("processConstituentCountRefresh", () => {
  it("refreshes count for an empty tenant (stays at 0) and a populated tenant (gets N)", async () => {
    await processConstituentCountRefresh(mockJob());

    const [empty] = await db
      .select({
        count: tenants.constituentCountCached,
        ts: tenants.constituentCountRefreshedAt,
      })
      .from(tenants)
      .where(eq(tenants.id, TENANT_EMPTY));
    expect(empty?.count).toBe(0);
    expect(empty?.ts).toBeTruthy();

    const [three] = await db
      .select({
        count: tenants.constituentCountCached,
        ts: tenants.constituentCountRefreshedAt,
      })
      .from(tenants)
      .where(eq(tenants.id, TENANT_WITH_THREE));
    // 3 live + 1 soft-deleted == 3 counted.
    expect(three?.count).toBe(3);
    expect(three?.ts).toBeTruthy();
  });

  it("skips archived tenants — refreshed_at stays NULL", async () => {
    await processConstituentCountRefresh(mockJob());
    const [arch] = await db
      .select({ ts: tenants.constituentCountRefreshedAt })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ARCHIVED));
    expect(arch?.ts).toBeNull();
  });

  it("no-op when the admin.finance_dashboard flag is off", async () => {
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, "admin.finance_dashboard"));
    // Mark a sentinel timestamp; if the job no-ops the column should
    // stay NULL.
    await db
      .update(tenants)
      .set({ constituentCountCached: 99, constituentCountRefreshedAt: null })
      .where(eq(tenants.id, TENANT_WITH_THREE));

    await processConstituentCountRefresh(mockJob());

    const [three] = await db
      .select({
        count: tenants.constituentCountCached,
        ts: tenants.constituentCountRefreshedAt,
      })
      .from(tenants)
      .where(eq(tenants.id, TENANT_WITH_THREE));
    expect(three?.count).toBe(99);
    expect(three?.ts).toBeNull();

    // Restore for the next test in the file (if any).
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, "admin.finance_dashboard"));
  });
});
