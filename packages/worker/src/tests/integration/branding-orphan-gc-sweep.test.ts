/**
 * Branding orphan-GC sweep — issue #291 (ADR-023 § Consequences,
 * ADR-024 "drift to nightly orphan-GC").
 *
 * Validates the three reap phases against a real Postgres:
 *   1. soft-deleted rows past the 7-day grace → S3 prefix swept + row
 *      hard-deleted; recent soft-deletes survive.
 *   2. replaced / never-activated rows past grace → swept; the ACTIVE
 *      asset (pointed at by `tenants.logo_asset_id`) and recent uploads
 *      survive.
 *   3. unowned `{org_id}/` prefixes (tenant hard-deleted) → swept only
 *      when the newest object is past grace; non-UUID prefixes are
 *      never touched.
 *
 * S3 is mocked at the worker's own `lib/s3.js` boundary (same pattern
 * as receipt-processor.test.ts / postal-export.test.ts) — CI has no
 * SeaweedFS service, and the S3 pagination logic lives in
 * `@givernance/shared/lib/s3-branding` behind that boundary.
 */

import { orgBrandingAssets, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

const deleteBrandingPrefix = vi.fn<(prefix: string) => Promise<number>>();
const listBrandingTopLevelPrefixes = vi.fn<() => Promise<string[]>>();
const newestBrandingObjectMtime = vi.fn<(prefix: string) => Promise<Date | null>>();

vi.mock("../../lib/s3.js", () => ({
  deleteBrandingPrefix: (prefix: string) => deleteBrandingPrefix(prefix),
  listBrandingTopLevelPrefixes: () => listBrandingTopLevelPrefixes(),
  newestBrandingObjectMtime: (prefix: string) => newestBrandingObjectMtime(prefix),
}));

// Import AFTER vi.mock so the processor binds the mocked s3 module.
const { processBrandingOrphanGcSweep } = await import(
  "../../processors/branding-orphan-gc-sweep.js"
);

const TENANT_LIVE = "00000000-0000-0000-0000-000000000291";
/** Hard-deleted tenant — exists only as an S3 prefix, never in the DB. */
const TENANT_GONE = "00000000-0000-0000-0000-000000000292";

const ASSET_ACTIVE = "00000000-0000-0000-aaaa-000000000001";
const ASSET_SOFT_DELETED_OLD = "00000000-0000-0000-aaaa-000000000002";
const ASSET_SOFT_DELETED_RECENT = "00000000-0000-0000-aaaa-000000000003";
const ASSET_REPLACED_OLD = "00000000-0000-0000-aaaa-000000000004";
const ASSET_REPLACED_RECENT = "00000000-0000-0000-aaaa-000000000005";

const DAY_MS = 24 * 60 * 60 * 1000;
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * DAY_MS);
const TWO_DAYS_AGO = new Date(Date.now() - 2 * DAY_MS);

function keyFor(orgId: string, assetId: string): string {
  return `${orgId}/logo/${assetId}/original.png`;
}

function prefixFor(orgId: string, assetId: string): string {
  return `${orgId}/logo/${assetId}/`;
}

function mockJob(): Job {
  return { id: "test-orphan-gc", data: {}, name: "branding.orphan_gc_sweep" } as unknown as Job;
}

async function seedAsset(input: {
  id: string;
  status?: string;
  deletedAt?: Date | null;
  updatedAt?: Date;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO org_branding_assets
      (id, org_id, asset_type, status, original_key, original_content_type,
       original_bytes, deleted_at, created_at, updated_at)
    VALUES
      (${input.id}, ${TENANT_LIVE}, 'org_logo', ${input.status ?? "ready"},
       ${keyFor(TENANT_LIVE, input.id)}, 'image/png', 1234,
       ${input.deletedAt ?? null}, ${input.updatedAt ?? EIGHT_DAYS_AGO},
       ${input.updatedAt ?? EIGHT_DAYS_AGO})
  `);
}

async function seedAll(): Promise<void> {
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_LIVE}, 'Orphan GC NPO', 'orphan-gc-npo-291', 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  // Active logo — old updated_at, but pointed at by the tenant → survives.
  await seedAsset({ id: ASSET_ACTIVE, updatedAt: EIGHT_DAYS_AGO });
  await db.execute(
    sql`UPDATE tenants SET logo_asset_id = ${ASSET_ACTIVE} WHERE id = ${TENANT_LIVE}`,
  );
  // Phase-1 target + decoy.
  await seedAsset({ id: ASSET_SOFT_DELETED_OLD, deletedAt: EIGHT_DAYS_AGO });
  await seedAsset({ id: ASSET_SOFT_DELETED_RECENT, deletedAt: TWO_DAYS_AGO });
  // Phase-2 target (replaced 8 days ago) + decoy (fresh upload, pending).
  await seedAsset({ id: ASSET_REPLACED_OLD, updatedAt: EIGHT_DAYS_AGO });
  await seedAsset({ id: ASSET_REPLACED_RECENT, status: "pending", updatedAt: TWO_DAYS_AGO });
}

async function cleanAll(): Promise<void> {
  await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${TENANT_LIVE}`);
  await db.execute(sql`DELETE FROM org_branding_assets WHERE org_id = ${TENANT_LIVE}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${TENANT_LIVE}`);
}

async function setFlag(enabled: boolean): Promise<void> {
  // Upsert so the test doesn't depend on the 0091 seed having run first.
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
    VALUES ('branding.orphan_gc_sweep', ${enabled}, 'Nightly logo storage cleanup', 'test', 'platform', FALSE, FALSE)
    ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled
  `);
}

async function remainingAssetIds(): Promise<string[]> {
  const rows = await db
    .select({ id: orgBrandingAssets.id })
    .from(orgBrandingAssets)
    .where(eq(orgBrandingAssets.orgId, TENANT_LIVE));
  return rows.map((r) => r.id).sort();
}

beforeAll(async () => {
  await cleanAll();
});

beforeEach(async () => {
  await cleanAll();
  await seedAll();
  await setFlag(true);
  deleteBrandingPrefix.mockReset().mockResolvedValue(5);
  listBrandingTopLevelPrefixes.mockReset().mockResolvedValue([]);
  newestBrandingObjectMtime.mockReset().mockResolvedValue(null);
});

afterAll(async () => {
  await cleanAll();
  await setFlag(false);
});

describe("processBrandingOrphanGcSweep", () => {
  it("no-ops (and deletes nothing) when the flag is off", async () => {
    await setFlag(false);
    const result = await processBrandingOrphanGcSweep(mockJob());
    expect(result.skipped).toBe(true);
    expect(deleteBrandingPrefix).not.toHaveBeenCalled();
    expect(listBrandingTopLevelPrefixes).not.toHaveBeenCalled();
    expect((await remainingAssetIds()).length).toBe(5);
  });

  it("reaps soft-deleted + replaced rows past grace, spares the active logo and recent rows", async () => {
    const result = await processBrandingOrphanGcSweep(mockJob());

    expect(result.skipped).toBe(false);
    expect(result.softDeletedReaped).toBe(1);
    expect(result.replacedReaped).toBe(1);
    expect(result.unownedPrefixesReaped).toBe(0);

    // Exactly the two orphans' prefixes were swept.
    const sweptPrefixes = deleteBrandingPrefix.mock.calls.map((c) => c[0]).sort();
    expect(sweptPrefixes).toEqual(
      [
        prefixFor(TENANT_LIVE, ASSET_SOFT_DELETED_OLD),
        prefixFor(TENANT_LIVE, ASSET_REPLACED_OLD),
      ].sort(),
    );

    // Rows: the two orphans are hard-deleted; active + the two recent
    // decoys survive.
    expect(await remainingAssetIds()).toEqual(
      [ASSET_ACTIVE, ASSET_SOFT_DELETED_RECENT, ASSET_REPLACED_RECENT].sort(),
    );

    // The active pointer is untouched.
    const [tenant] = await db
      .select({ logoAssetId: tenants.logoAssetId })
      .from(tenants)
      .where(eq(tenants.id, TENANT_LIVE));
    expect(tenant?.logoAssetId).toBe(ASSET_ACTIVE);
  });

  it("reaps an unowned prefix only past grace, skips live tenants and non-UUID prefixes", async () => {
    listBrandingTopLevelPrefixes.mockResolvedValue([
      `${TENANT_LIVE}/`, // live tenant → never phase-3 reaped
      `${TENANT_GONE}/`, // gone tenant, old objects → reaped
      "not-a-uuid/", // unexpected layout → warned + skipped
    ]);
    newestBrandingObjectMtime.mockResolvedValue(EIGHT_DAYS_AGO);

    const result = await processBrandingOrphanGcSweep(mockJob());

    expect(result.unownedPrefixesReaped).toBe(1);
    expect(newestBrandingObjectMtime).toHaveBeenCalledTimes(1);
    expect(newestBrandingObjectMtime).toHaveBeenCalledWith(`${TENANT_GONE}/`);
    expect(deleteBrandingPrefix).toHaveBeenCalledWith(`${TENANT_GONE}/`);
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith(`${TENANT_LIVE}/`);
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith("not-a-uuid/");
  });

  it("leaves an unowned prefix alone while its newest object is inside the grace window", async () => {
    listBrandingTopLevelPrefixes.mockResolvedValue([`${TENANT_GONE}/`]);
    newestBrandingObjectMtime.mockResolvedValue(TWO_DAYS_AGO);

    const result = await processBrandingOrphanGcSweep(mockJob());

    expect(result.unownedPrefixesReaped).toBe(0);
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith(`${TENANT_GONE}/`);
  });

  it("continues past a per-row S3 failure and retries the row on the next run", async () => {
    deleteBrandingPrefix.mockImplementation(async (prefix: string) => {
      if (prefix === prefixFor(TENANT_LIVE, ASSET_SOFT_DELETED_OLD)) {
        throw new Error("S3 down");
      }
      return 5;
    });

    const result = await processBrandingOrphanGcSweep(mockJob());

    // The failed row is NOT hard-deleted (stays for the next nightly
    // run); the other orphan is still reaped.
    expect(result.softDeletedReaped).toBe(0);
    expect(result.replacedReaped).toBe(1);
    expect(await remainingAssetIds()).toContain(ASSET_SOFT_DELETED_OLD);
    expect(await remainingAssetIds()).not.toContain(ASSET_REPLACED_OLD);
  });
});
