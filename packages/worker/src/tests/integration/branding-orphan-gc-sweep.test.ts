/**
 * Branding orphan-GC sweep — issue #291 (ADR-023 § Consequences,
 * ADR-024 "drift to nightly orphan-GC").
 *
 * Validates the three reap phases against a real Postgres:
 *   1. soft-deleted rows past the 7-day grace → S3 prefix swept + row
 *      hard-deleted + audit_logs entry; recent soft-deletes survive;
 *      a soft-deleted row support re-activated (pointer restored)
 *      survives (review M1).
 *   2. stale never-activated rows past grace → swept; the ACTIVE
 *      asset (pointed at by `tenants.logo_asset_id`) and recent
 *      uploads survive — including for a SECOND tenant (review M3).
 *   3. unowned `{org_id}/` prefixes (tenant hard-deleted) → swept only
 *      when the newest object is past grace; non-UUID prefixes are
 *      never touched; a LIST failure preserves phases 1–2 (review M4).
 *
 * Plus the replacement clock (review H1): `processBrandingActivateLogo`
 * soft-deletes the previous asset so the grace window starts at
 * replacement time, and the prefix guard (review H2): a row with an
 * out-of-namespace `original_key` is skipped, never deleted.
 *
 * S3 is mocked at the worker's own `lib/s3.js` boundary (same pattern
 * as receipt-processor.test.ts / postal-export.test.ts) — CI has no
 * SeaweedFS service. The pagination logic behind that boundary is
 * unit-tested in `packages/shared/src/lib/s3-branding.test.ts`.
 */

import { auditLogs, orgBrandingAssets, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
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

// Import AFTER vi.mock so the processors bind the mocked s3 module.
const { processBrandingOrphanGcSweep } = await import(
  "../../processors/branding-orphan-gc-sweep.js"
);
const { processBrandingActivateLogo } = await import("../../processors/branding-activate-logo.js");

const TENANT_LIVE = "00000000-0000-0000-0000-000000000291";
const TENANT_OTHER = "00000000-0000-0000-0000-000000000293";
/** Hard-deleted tenant — exists only as an S3 prefix, never in the DB. */
const TENANT_GONE = "00000000-0000-0000-0000-000000000292";
const TENANT_GONE_2 = "00000000-0000-0000-0000-000000000294";

const ASSET_ACTIVE = "00000000-0000-0000-aaaa-000000000001";
const ASSET_SOFT_DELETED_OLD = "00000000-0000-0000-aaaa-000000000002";
const ASSET_SOFT_DELETED_RECENT = "00000000-0000-0000-aaaa-000000000003";
const ASSET_REPLACED_OLD = "00000000-0000-0000-aaaa-000000000004";
const ASSET_REPLACED_RECENT = "00000000-0000-0000-aaaa-000000000005";
/** Other tenant's active logo — old updated_at, must survive (M3). */
const ASSET_OTHER_ACTIVE = "00000000-0000-0000-bbbb-000000000001";

const DAY_MS = 24 * 60 * 60 * 1000;
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * DAY_MS);
const TWO_DAYS_AGO = new Date(Date.now() - 2 * DAY_MS);

function keyFor(orgId: string, assetId: string): string {
  return `${orgId}/logo/${assetId}/original.png`;
}

function prefixFor(orgId: string, assetId: string): string {
  return `${orgId}/logo/${assetId}/`;
}

function mockJob(data: Record<string, unknown> = {}): Job {
  return { id: "test-orphan-gc", data, name: "branding.orphan_gc_sweep" } as unknown as Job;
}

async function seedAsset(input: {
  id: string;
  orgId?: string;
  status?: string;
  deletedAt?: Date | null;
  updatedAt?: Date;
  originalKey?: string;
}): Promise<void> {
  const orgId = input.orgId ?? TENANT_LIVE;
  await db.execute(sql`
    INSERT INTO org_branding_assets
      (id, org_id, asset_type, status, original_key, original_content_type,
       original_bytes, deleted_at, created_at, updated_at)
    VALUES
      (${input.id}, ${orgId}, 'org_logo', ${input.status ?? "ready"},
       ${input.originalKey ?? keyFor(orgId, input.id)}, 'image/png', 1234,
       ${input.deletedAt ?? null}, ${input.updatedAt ?? EIGHT_DAYS_AGO},
       ${input.updatedAt ?? EIGHT_DAYS_AGO})
  `);
}

async function seedAll(): Promise<void> {
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES
      (${TENANT_LIVE}, 'Orphan GC NPO', 'orphan-gc-npo-291', 'active'),
      (${TENANT_OTHER}, 'Other NPO', 'orphan-gc-other-291', 'active')
    ON CONFLICT (id) DO NOTHING
  `);
  // Active logos — old updated_at, but pointed at by their tenant → survive.
  await seedAsset({ id: ASSET_ACTIVE, updatedAt: EIGHT_DAYS_AGO });
  await seedAsset({ id: ASSET_OTHER_ACTIVE, orgId: TENANT_OTHER, updatedAt: EIGHT_DAYS_AGO });
  await db.execute(
    sql`UPDATE tenants SET logo_asset_id = ${ASSET_ACTIVE} WHERE id = ${TENANT_LIVE}`,
  );
  await db.execute(
    sql`UPDATE tenants SET logo_asset_id = ${ASSET_OTHER_ACTIVE} WHERE id = ${TENANT_OTHER}`,
  );
  // Phase-1 target + decoy.
  await seedAsset({ id: ASSET_SOFT_DELETED_OLD, deletedAt: EIGHT_DAYS_AGO });
  await seedAsset({ id: ASSET_SOFT_DELETED_RECENT, deletedAt: TWO_DAYS_AGO });
  // Phase-2 target (never-activated, 8 days old) + decoy (fresh pending).
  await seedAsset({ id: ASSET_REPLACED_OLD, updatedAt: EIGHT_DAYS_AGO });
  await seedAsset({ id: ASSET_REPLACED_RECENT, status: "pending", updatedAt: TWO_DAYS_AGO });
}

async function cleanAll(): Promise<void> {
  // audit_logs has ON DELETE RESTRICT on org_id AND an immutability
  // trigger that blocks DELETE. `SET LOCAL session_replication_role =
  // 'replica'` bypasses the trigger for this transaction only — the
  // established harness pattern (signup.test.ts / onboarding-runtime
  // in packages/api). Production never runs with this flag.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${TENANT_LIVE}, ${TENANT_OTHER})`);
    await tx.execute(
      sql`DELETE FROM outbox_events WHERE tenant_id IN (${TENANT_LIVE}, ${TENANT_OTHER})`,
    );
    await tx.execute(
      sql`UPDATE tenants SET logo_asset_id = NULL WHERE id IN (${TENANT_LIVE}, ${TENANT_OTHER})`,
    );
    await tx.execute(
      sql`DELETE FROM org_branding_assets WHERE org_id IN (${TENANT_LIVE}, ${TENANT_OTHER})`,
    );
    await tx.execute(sql`DELETE FROM tenants WHERE id IN (${TENANT_LIVE}, ${TENANT_OTHER})`);
  });
}

async function setFlag(enabled: boolean): Promise<void> {
  // Upsert so the test doesn't depend on the 0091 seed having run first.
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
    VALUES ('branding.orphan_gc_sweep', ${enabled}, 'Nightly logo storage cleanup', 'test', 'platform', FALSE, FALSE)
    ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled
  `);
}

async function remainingAssetIds(orgId: string = TENANT_LIVE): Promise<string[]> {
  const rows = await db
    .select({ id: orgBrandingAssets.id })
    .from(orgBrandingAssets)
    .where(eq(orgBrandingAssets.orgId, orgId));
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

  it("reaps soft-deleted + stale rows past grace, spares active logos of BOTH tenants and recent rows", async () => {
    const result = await processBrandingOrphanGcSweep(mockJob());

    expect(result.skipped).toBe(false);
    expect(result.softDeletedReaped).toBe(1);
    expect(result.replacedReaped).toBe(1);
    expect(result.unownedPrefixesReaped).toBe(0);
    // 2 reaps × 5 mocked objects per prefix.
    expect(result.objectsDeleted).toBe(10);

    // Exactly the two orphans' prefixes were swept.
    const sweptPrefixes = deleteBrandingPrefix.mock.calls.map((c) => c[0]).sort();
    expect(sweptPrefixes).toEqual(
      [
        prefixFor(TENANT_LIVE, ASSET_SOFT_DELETED_OLD),
        prefixFor(TENANT_LIVE, ASSET_REPLACED_OLD),
      ].sort(),
    );

    // Rows: the two orphans are hard-deleted; active + the two recent
    // decoys survive; the OTHER tenant's old-but-active logo survives
    // untouched (review M3 — join correctness).
    expect(await remainingAssetIds()).toEqual(
      [ASSET_ACTIVE, ASSET_SOFT_DELETED_RECENT, ASSET_REPLACED_RECENT].sort(),
    );
    expect(await remainingAssetIds(TENANT_OTHER)).toEqual([ASSET_OTHER_ACTIVE]);

    // Active pointers untouched.
    const pointers = await db
      .select({ id: tenants.id, logoAssetId: tenants.logoAssetId })
      .from(tenants)
      .where(sql`${tenants.id} IN (${TENANT_LIVE}, ${TENANT_OTHER})`);
    expect(new Map(pointers.map((p) => [p.id, p.logoAssetId]))).toEqual(
      new Map([
        [TENANT_LIVE, ASSET_ACTIVE],
        [TENANT_OTHER, ASSET_OTHER_ACTIVE],
      ]),
    );

    // GDPR Art. 5(2): each DB-row reap left an audit trail.
    const audits = await db
      .select({ resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.orgId, TENANT_LIVE), eq(auditLogs.action, "branding.orphan_gc_reaped")),
      );
    expect(audits.map((a) => a.resourceId).sort()).toEqual(
      [ASSET_SOFT_DELETED_OLD, ASSET_REPLACED_OLD].sort(),
    );
  });

  it("never reaps a soft-deleted row that support re-activated (pointer wins — review M1)", async () => {
    // Support restored the wrongly-deleted logo by repointing WITHOUT
    // clearing deleted_at.
    await db.execute(
      sql`UPDATE tenants SET logo_asset_id = ${ASSET_SOFT_DELETED_OLD} WHERE id = ${TENANT_LIVE}`,
    );

    const result = await processBrandingOrphanGcSweep(mockJob());

    expect(result.softDeletedReaped).toBe(0);
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith(
      prefixFor(TENANT_LIVE, ASSET_SOFT_DELETED_OLD),
    );
    expect(await remainingAssetIds()).toContain(ASSET_SOFT_DELETED_OLD);
    // ASSET_ACTIVE is now unpointed + 8 days old → legitimately reaped
    // by phase 2 in this configuration.
  });

  it("skips (never deletes) a row whose original_key escapes its org/logo namespace — review H2", async () => {
    await db.execute(
      sql`DELETE FROM org_branding_assets WHERE org_id = ${TENANT_LIVE} AND id IN (${ASSET_SOFT_DELETED_OLD}, ${ASSET_REPLACED_OLD})`,
    );
    const EVIL_A = "00000000-0000-0000-cccc-000000000001";
    const EVIL_B = "00000000-0000-0000-cccc-000000000002";
    const EVIL_C = "00000000-0000-0000-cccc-000000000003";
    // Empty-ish key, one-level-short key, cross-tenant key.
    await seedAsset({ id: EVIL_A, deletedAt: EIGHT_DAYS_AGO, originalKey: "original.png" });
    await seedAsset({
      id: EVIL_B,
      deletedAt: EIGHT_DAYS_AGO,
      originalKey: `${TENANT_LIVE}/original.png`,
    });
    await seedAsset({
      id: EVIL_C,
      deletedAt: EIGHT_DAYS_AGO,
      originalKey: keyFor(TENANT_OTHER, ASSET_OTHER_ACTIVE),
    });

    const result = await processBrandingOrphanGcSweep(mockJob());

    // None of the three malformed rows triggered any S3 delete, and
    // their rows survive for manual review.
    expect(result.softDeletedReaped).toBe(0);
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith("");
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith(`${TENANT_LIVE}/`);
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith(
      prefixFor(TENANT_OTHER, ASSET_OTHER_ACTIVE),
    );
    const survivors = await remainingAssetIds();
    expect(survivors).toEqual(expect.arrayContaining([EVIL_A, EVIL_B, EVIL_C]));
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

  it("continues past a failing prefix in phase 3 and still reaps the next one", async () => {
    listBrandingTopLevelPrefixes.mockResolvedValue([`${TENANT_GONE}/`, `${TENANT_GONE_2}/`]);
    newestBrandingObjectMtime.mockImplementation(async (prefix: string) => {
      if (prefix === `${TENANT_GONE}/`) throw new Error("S3 flake");
      return EIGHT_DAYS_AGO;
    });

    const result = await processBrandingOrphanGcSweep(mockJob());

    expect(result.unownedPrefixesReaped).toBe(1);
    expect(deleteBrandingPrefix).toHaveBeenCalledWith(`${TENANT_GONE_2}/`);
  });

  it("a phase-3 LIST failure preserves the committed phase 1–2 work — review M4", async () => {
    listBrandingTopLevelPrefixes.mockRejectedValue(new Error("S3 LIST down"));

    const result = await processBrandingOrphanGcSweep(mockJob());

    // The job resolves (no throw → no BullMQ retry storm), phases 1–2
    // did their work, phase 3 reaped nothing.
    expect(result.softDeletedReaped).toBe(1);
    expect(result.replacedReaped).toBe(1);
    expect(result.unownedPrefixesReaped).toBe(0);
    expect(await remainingAssetIds()).toEqual(
      [ASSET_ACTIVE, ASSET_SOFT_DELETED_RECENT, ASSET_REPLACED_RECENT].sort(),
    );
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

describe("processBrandingActivateLogo — replacement starts the GC grace clock (review H1)", () => {
  it("soft-deletes the previous asset when repointing, so the sweep spares it for 7 days", async () => {
    const ASSET_NEW = "00000000-0000-0000-dddd-000000000001";
    await seedAsset({ id: ASSET_NEW, status: "ready", updatedAt: new Date() });

    await processBrandingActivateLogo({
      id: "test-activate",
      name: "branding.activate_logo",
      data: { assetId: ASSET_NEW, orgId: TENANT_LIVE },
    } as unknown as Job);

    const [tenant] = await db
      .select({ logoAssetId: tenants.logoAssetId })
      .from(tenants)
      .where(eq(tenants.id, TENANT_LIVE));
    expect(tenant?.logoAssetId).toBe(ASSET_NEW);

    // The replaced asset is now soft-deleted with a FRESH deleted_at —
    // inside the grace window, so tonight's sweep must spare it.
    const [previous] = await db
      .select({ deletedAt: orgBrandingAssets.deletedAt })
      .from(orgBrandingAssets)
      .where(and(eq(orgBrandingAssets.id, ASSET_ACTIVE), eq(orgBrandingAssets.orgId, TENANT_LIVE)));
    expect(previous?.deletedAt).toBeTruthy();

    const result = await processBrandingOrphanGcSweep(mockJob());
    expect(deleteBrandingPrefix).not.toHaveBeenCalledWith(prefixFor(TENANT_LIVE, ASSET_ACTIVE));
    expect(await remainingAssetIds()).toContain(ASSET_ACTIVE);
    expect(result.skipped).toBe(false);
  });

  it("is idempotent on retry — re-activating the same asset soft-deletes nothing", async () => {
    await processBrandingActivateLogo({
      id: "test-activate-idem",
      name: "branding.activate_logo",
      data: { assetId: ASSET_ACTIVE, orgId: TENANT_LIVE },
    } as unknown as Job);

    const [active] = await db
      .select({ deletedAt: orgBrandingAssets.deletedAt })
      .from(orgBrandingAssets)
      .where(and(eq(orgBrandingAssets.id, ASSET_ACTIVE), eq(orgBrandingAssets.orgId, TENANT_LIVE)));
    expect(active?.deletedAt).toBeNull();
  });
});
