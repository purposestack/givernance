/**
 * Option-merge backfill + merge-undo purge integration tests (Epic #539).
 *
 * Pins the pipeline contract:
 *   - the backfill only runs while the source option still carries THIS
 *     job's merge marker (`mergeId` + `mergedInto`, stamped by the API in
 *     the same tx as the outbox row) — an undo between emit and pickup
 *     makes the replayed job a hard skip, never a re-mark,
 *   - stored picklist scalars and multi_picklist arrays are rewritten
 *     source → target (arrays deduped when the row already carried both),
 *   - one `custom_field_merge_undo` row per rewritten entity, holding
 *     ONLY the pre-merge value of the touched key,
 *   - one counts-only audit row (anti-goal #7: no value snapshots),
 *   - idempotent re-run rewrites nothing and duplicates no undo rows,
 *   - flag off ⇒ job dropped untouched (defence in depth),
 *   - GDPR erasure purges the subject's undo rows, so a post-erasure undo
 *     restores living rows but never resurrects values onto erased ones,
 *   - the per-org custom-field VALUES advisory lock serialises backfill /
 *     restore chunks against a CONCURRENT erasure transaction, so neither
 *     pipeline can re-add erased values or leak pre-erasure values into
 *     the 30-day undo store — pinned on the donation domain, which has no
 *     `deleted_at` second wall,
 *   - the purge cron deletes only expired undo rows.
 */

import { randomUUID } from "node:crypto";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  auditLogs,
  constituents,
  customFieldDefinitions,
  customFieldMergeUndo,
  donations,
  tenantFlagOverrides,
  tenants,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireCustomFieldValuesLock } from "../../lib/custom-field-locks.js";
import { db } from "../../lib/db.js";
import { processCustomFieldOptionMerge } from "../../processors/custom-field-option-merge.js";
import { processCustomFieldOptionMergeUndo } from "../../processors/custom-field-option-merge-undo.js";
import { processCustomFieldUndoPurge } from "../../processors/custom-field-undo-purge.js";
import { processGdprErasure } from "../../processors/gdpr-erasure.js";

// Unique per test file — worker suites run in parallel, so sharing a
// tenant id with another file races setup/teardown (23503 on tenant
// delete when a sibling file's audit rows still reference it).
const TENANT_ID = "00000000-0000-0000-0000-000000539001";
const PICKLIST_DEF_ID = "00000000-0000-0000-0000-00000000d539";
const MULTI_DEF_ID = "00000000-0000-0000-0000-00000000e539";
const UNDONE_DEF_ID = "00000000-0000-0000-0000-00000000f539";
const ERASE_DEF_ID = "00000000-0000-0000-0000-00000000f540";
const REQUESTED_BY = "00000000-0000-0000-0000-00000000a539";

const SRC = "opt_srcsrc01";
const TGT = "opt_tgttgt01";
const OTHER = "opt_othoth01";

const C_SCALAR = "00000000-0000-0000-0000-00000000c001";
const C_UNTOUCHED = "00000000-0000-0000-0000-00000000c002";
const C_MULTI = "00000000-0000-0000-0000-00000000c003";
const C_MULTI_DEDUPE = "00000000-0000-0000-0000-00000000c004";
const C_UNDONE = "00000000-0000-0000-0000-00000000c005";
const C_ERASE = "00000000-0000-0000-0000-00000000c006";
const C_ALIVE = "00000000-0000-0000-0000-00000000c007";

function fakeJob(data: Record<string, unknown>): Job<never> {
  return { id: `test-${randomUUID().slice(0, 8)}`, data } as unknown as Job<never>;
}

async function setFlag(
  enabled: boolean,
  flagKey: string = FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
): Promise<void> {
  await db
    .insert(tenantFlagOverrides)
    .values({
      tenantId: TENANT_ID,
      flagKey,
      value: enabled,
    })
    .onConflictDoUpdate({
      target: [tenantFlagOverrides.tenantId, tenantFlagOverrides.flagKey],
      set: { value: enabled },
    });
}

beforeAll(async () => {
  const slug = `cf-merge-${randomUUID().slice(0, 8)}`;
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${TENANT_ID}, 'Tenant #539', ${slug}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET status = 'active'`,
  );
  await setFlag(true);

  await db
    .insert(customFieldDefinitions)
    .values([
      {
        id: PICKLIST_DEF_ID,
        orgId: TENANT_ID,
        domain: "constituent",
        key: "donor_segment",
        label: "Segment donateur",
        type: "picklist",
        options: [
          { id: SRC, label: "Amis", active: true, sortOrder: 0 },
          { id: TGT, label: "Ami", active: true, sortOrder: 1 },
        ],
      },
      {
        id: MULTI_DEF_ID,
        orgId: TENANT_ID,
        domain: "constituent",
        key: "interests",
        label: "Centres d'intérêt",
        type: "multi_picklist",
        options: [
          { id: SRC, label: "Sports", active: true, sortOrder: 0 },
          { id: TGT, label: "Sport", active: true, sortOrder: 1 },
          { id: OTHER, label: "Culture", active: true, sortOrder: 2 },
        ],
      },
      {
        id: UNDONE_DEF_ID,
        orgId: TENANT_ID,
        domain: "constituent",
        key: "vip_tier",
        label: "Niveau VIP",
        type: "picklist",
        options: [
          { id: SRC, label: "Or", active: true, sortOrder: 0 },
          { id: TGT, label: "Gold", active: true, sortOrder: 1 },
        ],
      },
      {
        id: ERASE_DEF_ID,
        orgId: TENANT_ID,
        domain: "constituent",
        key: "loyalty",
        label: "Fidélité",
        type: "picklist",
        options: [
          { id: SRC, label: "Fidèle", active: true, sortOrder: 0 },
          { id: TGT, label: "Fidele", active: true, sortOrder: 1 },
        ],
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(constituents)
    .values([
      {
        id: C_SCALAR,
        orgId: TENANT_ID,
        firstName: "Scalar",
        lastName: "Row",
        custom: { donor_segment: SRC },
      },
      {
        id: C_UNTOUCHED,
        orgId: TENANT_ID,
        firstName: "Untouched",
        lastName: "Row",
        custom: { donor_segment: TGT },
      },
      {
        id: C_MULTI,
        orgId: TENANT_ID,
        firstName: "Multi",
        lastName: "Row",
        custom: { interests: [SRC, OTHER] },
      },
      {
        id: C_MULTI_DEDUPE,
        orgId: TENANT_ID,
        firstName: "Dedupe",
        lastName: "Row",
        custom: { interests: [SRC, TGT] },
      },
      {
        id: C_UNDONE,
        orgId: TENANT_ID,
        firstName: "Undone",
        lastName: "Row",
        custom: { vip_tier: SRC },
      },
      {
        id: C_ERASE,
        orgId: TENANT_ID,
        firstName: "Erase",
        lastName: "Me",
        custom: { loyalty: SRC },
      },
      {
        id: C_ALIVE,
        orgId: TENANT_ID,
        firstName: "Alive",
        lastName: "Row",
        custom: { loyalty: SRC },
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  // audit_logs is immutable by trigger — session-scoped bypass ONLY in
  // test cleanup, same pattern as survey-erasure-cascade.test.ts.
  await db.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable`);
  try {
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, TENANT_ID),
          inArray(auditLogs.action, [
            "custom_field.option_merge_backfilled",
            "custom_field.option_merge_undo_backfilled",
            "erasure",
          ]),
        ),
      );
  } finally {
    await db.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable`);
  }
  await db.delete(customFieldMergeUndo).where(eq(customFieldMergeUndo.orgId, TENANT_ID));
  // Donations first — their constituent FK has no cascade.
  await db.delete(donations).where(eq(donations.orgId, TENANT_ID));
  await db.delete(constituents).where(eq(constituents.orgId, TENANT_ID));
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, TENANT_ID));
  await db.delete(tenantFlagOverrides).where(eq(tenantFlagOverrides.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

async function customOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ custom: constituents.custom })
    .from(constituents)
    .where(and(eq(constituents.id, id), eq(constituents.orgId, TENANT_ID)));
  return (row?.custom ?? {}) as Record<string, unknown>;
}

async function optionsOf(definitionId: string) {
  const [def] = await db
    .select({ options: customFieldDefinitions.options })
    .from(customFieldDefinitions)
    .where(
      and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, TENANT_ID)),
    );
  return def?.options ?? [];
}

/**
 * Simulate the API's `mergeOption` stamp: `{ active: false, mergedInto,
 * mergeId, mergedAt }` on the source option. The service writes this in
 * the SAME transaction as the outbox row that carries the job — the
 * worker only backfills while THIS job's marker is still in place.
 */
async function stampMergeMarker(definitionId: string, mergeId: string): Promise<void> {
  const next = (await optionsOf(definitionId)).map((option) =>
    option.id === SRC
      ? { ...option, active: false, mergedInto: TGT, mergeId, mergedAt: new Date().toISOString() }
      : option,
  );
  await db
    .update(customFieldDefinitions)
    .set({ options: next })
    .where(
      and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, TENANT_ID)),
    );
}

/**
 * Simulate the API's `undoOptionMerge` restore: re-activate the source
 * option and drop `mergedInto` / `mergeId` / `mergedAt` — exactly what
 * the route does before emitting the undo job.
 */
async function clearMergeMarker(definitionId: string): Promise<void> {
  const next = (await optionsOf(definitionId)).map((option) => {
    if (option.id !== SRC) return option;
    const { mergedInto: _m, mergeId: _i, mergedAt: _a, ...rest } = option;
    return { ...rest, active: true };
  });
  await db
    .update(customFieldDefinitions)
    .set({ options: next })
    .where(
      and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, TENANT_ID)),
    );
}

describe("processCustomFieldOptionMerge", () => {
  it("drops the job when the domain flag is off for the tenant", async () => {
    await setFlag(false);
    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: randomUUID(),
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "skipped", reason: "flag_disabled" });
    expect((await customOf(C_SCALAR)).donor_segment).toBe(SRC);
    await setFlag(true);
  });

  // Shared across the rewrite + idempotency tests below — a BullMQ retry
  // re-delivers the SAME job (same mergeId), never a fresh one.
  const SCALAR_MERGE_ID = randomUUID();

  it("rewrites scalar picklist values, writes undo rows, preserves the API's marker, audits counts only", async () => {
    const mergeId = SCALAR_MERGE_ID;
    await stampMergeMarker(PICKLIST_DEF_ID, mergeId);
    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId,
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
        requestedBy: REQUESTED_BY,
      }),
    );
    expect(result).toEqual({ status: "completed", rewrittenRows: 1, chunks: 1 });

    expect((await customOf(C_SCALAR)).donor_segment).toBe(TGT);
    // A row already holding the target is never touched.
    expect((await customOf(C_UNTOUCHED)).donor_segment).toBe(TGT);

    const undoRows = await db
      .select()
      .from(customFieldMergeUndo)
      .where(
        and(eq(customFieldMergeUndo.orgId, TENANT_ID), eq(customFieldMergeUndo.mergeId, mergeId)),
      );
    expect(undoRows).toHaveLength(1);
    expect(undoRows[0]).toMatchObject({
      definitionId: PICKLIST_DEF_ID,
      entityId: C_SCALAR,
      sourceOptionId: SRC,
      targetOptionId: TGT,
      previousValue: SRC,
    });

    const [def] = await db
      .select({ options: customFieldDefinitions.options })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, PICKLIST_DEF_ID),
          eq(customFieldDefinitions.orgId, TENANT_ID),
        ),
      );
    const sourceOption = def?.options.find((option) => option.id === SRC);
    // The worker never rewrites the marker — mergeId/mergedInto survive
    // exactly as the API stamped them (they are the undo handle).
    expect(sourceOption).toMatchObject({ active: false, mergedInto: TGT, mergeId });

    const audits = await db
      .select({ userId: auditLogs.userId, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, TENANT_ID),
          eq(auditLogs.action, "custom_field.option_merge_backfilled"),
          eq(auditLogs.resourceId, PICKLIST_DEF_ID),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe(REQUESTED_BY);
    expect(audits[0]?.newValues).toMatchObject({
      mergeId,
      sourceOptionId: SRC,
      targetOptionId: TGT,
      rewrittenRows: 1,
    });
    // Counts + ids only — the audit blob must never carry row values.
    expect(JSON.stringify(audits[0]?.newValues)).not.toContain("previousValue");
  });

  it("re-delivery of the SAME job is idempotent: nothing rewritten, no duplicate undo rows", async () => {
    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: SCALAR_MERGE_ID,
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "completed", rewrittenRows: 0, chunks: 0 });
    // Still exactly the one undo row from the first delivery.
    const undoRows = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(
          eq(customFieldMergeUndo.orgId, TENANT_ID),
          eq(customFieldMergeUndo.mergeId, SCALAR_MERGE_ID),
        ),
      );
    expect(undoRows).toHaveLength(1);
  });

  it("rewrites multi_picklist arrays and dedupes when source and target coexist", async () => {
    const mergeId = randomUUID();
    await stampMergeMarker(MULTI_DEF_ID, mergeId);
    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId,
        definitionId: MULTI_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "completed", rewrittenRows: 2, chunks: 1 });

    expect((await customOf(C_MULTI)).interests).toEqual([TGT, OTHER]);
    expect((await customOf(C_MULTI_DEDUPE)).interests).toEqual([TGT]);

    const undoRows = await db
      .select({
        entityId: customFieldMergeUndo.entityId,
        previousValue: customFieldMergeUndo.previousValue,
      })
      .from(customFieldMergeUndo)
      .where(
        and(eq(customFieldMergeUndo.orgId, TENANT_ID), eq(customFieldMergeUndo.mergeId, mergeId)),
      );
    expect(undoRows).toHaveLength(2);
    const dedupeUndo = undoRows.find((row) => row.entityId === C_MULTI_DEDUPE);
    expect(dedupeUndo?.previousValue).toEqual([SRC, TGT]);
  });

  it("drops the job when the source option does not exist on the definition", async () => {
    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: randomUUID(),
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: "opt_missing1",
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "skipped", reason: "option_not_found" });
  });

  it("skips — never re-marks — when an undo cleared this job's merge marker before pickup", async () => {
    const mergeId = randomUUID();
    // The API merge stamped the marker + emitted the job…
    await stampMergeMarker(UNDONE_DEF_ID, mergeId);
    // …then the admin undid the merge BEFORE the relayed job ran (relay
    // lag / backlog / Redis outage — a timing the service explicitly
    // supports). The undo cleared the marker and re-activated the option.
    await clearMergeMarker(UNDONE_DEF_ID);

    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId,
        definitionId: UNDONE_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
        requestedBy: REQUESTED_BY,
      }),
    );
    expect(result).toEqual({ status: "skipped", reason: "merge_marker_missing" });

    // Zero rows rewritten, zero undo rows…
    expect((await customOf(C_UNDONE)).vip_tier).toBe(SRC);
    const undoRows = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(eq(customFieldMergeUndo.orgId, TENANT_ID), eq(customFieldMergeUndo.mergeId, mergeId)),
      );
    expect(undoRows).toHaveLength(0);

    // …and the option stays exactly as the undo left it: active, no
    // merge handle. (The old behaviour re-marked it `{ active: false,
    // mergedInto }` WITHOUT mergeId/mergedAt — a bricked state where
    // reactivate, re-merge, and undo all 422 with no recovery path.)
    const source = (await optionsOf(UNDONE_DEF_ID)).find((option) => option.id === SRC);
    expect(source).toMatchObject({ active: true });
    expect(source?.mergedInto).toBeUndefined();
    expect(source?.mergeId).toBeUndefined();
    expect(source?.mergedAt).toBeUndefined();
  });
});

describe("processCustomFieldOptionMergeUndo", () => {
  const UNDO_MERGE_ID = randomUUID();

  it("restores previous values from undo rows, consumes them, audits counts only", async () => {
    // Pre-state: the scalar merge above left C_SCALAR at the target id;
    // seed the undo row of a merge the API route would have recorded.
    await db.insert(customFieldMergeUndo).values({
      orgId: TENANT_ID,
      definitionId: PICKLIST_DEF_ID,
      mergeId: UNDO_MERGE_ID,
      sourceOptionId: SRC,
      targetOptionId: TGT,
      entityId: C_SCALAR,
      previousValue: SRC,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await processCustomFieldOptionMergeUndo(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: UNDO_MERGE_ID,
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
        requestedBy: REQUESTED_BY,
      }),
    );
    expect(result).toEqual({ status: "completed", restoredRows: 1, chunks: 1 });
    expect((await customOf(C_SCALAR)).donor_segment).toBe(SRC);

    const remaining = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(
          eq(customFieldMergeUndo.orgId, TENANT_ID),
          eq(customFieldMergeUndo.mergeId, UNDO_MERGE_ID),
        ),
      );
    expect(remaining).toHaveLength(0);

    const audits = await db
      .select({ userId: auditLogs.userId, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, TENANT_ID),
          eq(auditLogs.action, "custom_field.option_merge_undo_backfilled"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe(REQUESTED_BY);
    expect(audits[0]?.newValues).toMatchObject({ mergeId: UNDO_MERGE_ID, restoredRows: 1 });
    expect(JSON.stringify(audits[0]?.newValues)).not.toContain("previousValue");
  });

  it("re-run is idempotent: the consumed undo store restores nothing", async () => {
    const result = await processCustomFieldOptionMergeUndo(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: UNDO_MERGE_ID,
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "completed", restoredRows: 0, chunks: 0 });
    expect((await customOf(C_SCALAR)).donor_segment).toBe(SRC);
  });

  it("drops the job when the domain flag is off for the tenant", async () => {
    await setFlag(false);
    const result = await processCustomFieldOptionMergeUndo(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: randomUUID(),
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "skipped", reason: "flag_disabled" });
    await setFlag(true);
  });
});

describe("option-merge undo × GDPR erasure (Art. 17)", () => {
  const ERASE_MERGE_ID = randomUUID();

  it("erasure purges the subject's undo rows; a later undo restores living rows only", async () => {
    await stampMergeMarker(ERASE_DEF_ID, ERASE_MERGE_ID);
    const merged = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: ERASE_MERGE_ID,
        definitionId: ERASE_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
        requestedBy: REQUESTED_BY,
      }),
    );
    expect(merged).toEqual({ status: "completed", rewrittenRows: 2, chunks: 1 });

    // Art. 17 erasure of one of the two donors — runs INSIDE the 30-day
    // undo window, the exact interleaving the resurrection bug needs.
    const erased = await processGdprErasure(
      fakeJob({
        orgId: TENANT_ID,
        constituentId: C_ERASE,
        requestedBy: REQUESTED_BY,
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(erased).toMatchObject({ status: "erased", constituentId: C_ERASE });
    expect(await customOf(C_ERASE)).toEqual({});

    // The subject's undo row went with the erasure; the living donor's
    // row survives, so the merge stays fully undoable for them.
    const undoRows = await db
      .select({ entityId: customFieldMergeUndo.entityId })
      .from(customFieldMergeUndo)
      .where(
        and(
          eq(customFieldMergeUndo.orgId, TENANT_ID),
          eq(customFieldMergeUndo.mergeId, ERASE_MERGE_ID),
        ),
      );
    expect(undoRows.map((row) => row.entityId)).toEqual([C_ALIVE]);

    // Admin undoes the merge after the erasure: the API clears the
    // marker, the worker restores from the undo store.
    await clearMergeMarker(ERASE_DEF_ID);
    const undone = await processCustomFieldOptionMergeUndo(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: ERASE_MERGE_ID,
        definitionId: ERASE_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
        requestedBy: REQUESTED_BY,
      }),
    );
    expect(undone).toEqual({ status: "completed", restoredRows: 1, chunks: 1 });

    // The living row is restored; the erased row keeps its wiped blob.
    expect((await customOf(C_ALIVE)).loyalty).toBe(SRC);
    expect(await customOf(C_ERASE)).toEqual({});
  });

  it("deleted_at guard is the second wall: an undo row racing erasure is consumed without restoring", async () => {
    // Simulate a backfill chunk landing its undo row AFTER the erasure
    // transaction purged the store — the row exists, but the restore
    // UPDATE must skip the soft-deleted (erased) constituent.
    const raceMergeId = randomUUID();
    await db.insert(customFieldMergeUndo).values({
      orgId: TENANT_ID,
      definitionId: ERASE_DEF_ID,
      mergeId: raceMergeId,
      sourceOptionId: SRC,
      targetOptionId: TGT,
      entityId: C_ERASE,
      previousValue: SRC,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await processCustomFieldOptionMergeUndo(
      fakeJob({
        orgId: TENANT_ID,
        mergeId: raceMergeId,
        definitionId: ERASE_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    // The undo row is consumed (retries stay clean) but nothing counts
    // as restored — the erased constituent's UPDATE is skipped by the
    // `deleted_at IS NULL` guard.
    expect(result).toEqual({ status: "completed", restoredRows: 0, chunks: 1 });
    const remaining = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(
          eq(customFieldMergeUndo.orgId, TENANT_ID),
          eq(customFieldMergeUndo.mergeId, raceMergeId),
        ),
      );
    expect(remaining).toHaveLength(0);
    // …but nothing is resurrected onto the erased row.
    expect(await customOf(C_ERASE)).toEqual({});
  });
});

/**
 * Statement-level race between an erasure TRANSACTION and the merge /
 * undo chunk transactions (PR #550 MAJOR-2 residual). Deterministic
 * orchestration: a held-open transaction takes the SAME per-org
 * custom-field VALUES advisory lock the erasure processor takes, applies
 * the erasure's writes (Art. 9 key strip + undo-store purge), and only
 * commits after the worker job has been launched — the exact interleaving
 * in which the unguarded pipeline re-added erased values and leaked
 * pre-erasure values into the 30-day undo store. Pinned on the DONATION
 * domain, which has no `deleted_at` second wall.
 */
describe("option merge / undo racing a concurrent erasure transaction (donation domain)", () => {
  const DONATION_DEF_ID = "00000000-0000-0000-0000-00000000f541";
  const C_DONOR = "00000000-0000-0000-0000-00000000c008";
  const D_MERGE_RACE = "00000000-0000-0000-0000-00000000d001";
  const D_UNDO_RACE = "00000000-0000-0000-0000-00000000d002";

  beforeAll(async () => {
    await setFlag(true, FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS);
    await db
      .insert(customFieldDefinitions)
      .values({
        id: DONATION_DEF_ID,
        orgId: TENANT_ID,
        domain: "donation",
        key: "gift_reason",
        label: "Motif du don",
        type: "picklist",
        sensitive: true,
        purposeText: "Adaptation des remerciements (test)",
        options: [
          { id: SRC, label: "En mémoire", active: true, sortOrder: 0 },
          { id: TGT, label: "In memoriam", active: true, sortOrder: 1 },
        ],
      })
      .onConflictDoNothing();
    await db
      .insert(constituents)
      .values({ id: C_DONOR, orgId: TENANT_ID, firstName: "Donor", lastName: "Race" })
      .onConflictDoNothing();
    await db
      .insert(donations)
      .values([
        {
          id: D_MERGE_RACE,
          orgId: TENANT_ID,
          constituentId: C_DONOR,
          amountCents: 5000,
          amountBaseCents: 5000,
          custom: { gift_reason: SRC },
        },
        {
          // Post-merge state: an undo row below points back at SRC.
          id: D_UNDO_RACE,
          orgId: TENANT_ID,
          constituentId: C_DONOR,
          amountCents: 7000,
          amountBaseCents: 7000,
          custom: { gift_reason: TGT },
        },
      ])
      .onConflictDoNothing();
  });

  /**
   * Run `work` inside a held-open transaction that owns the custom-field
   * VALUES advisory lock, launch `during` while the lock is still held,
   * then commit and await both. Returns `during`'s result.
   */
  async function withHeldErasureTx<T>(
    work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
    during: () => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const erasureTx = db.transaction(async (tx) => {
      // The literal lock helper the erasure processor uses — key parity
      // with the worker pipelines is the point of the test.
      await acquireCustomFieldValuesLock(tx, TENANT_ID);
      await work(tx);
      ready();
      await held;
    });
    await lockReady;
    const duringPromise = during();
    // Give the job time to reach — and block on — the chunk's advisory
    // lock. (If it hasn't reached it yet, it simply runs after the
    // commit; the assertions hold in either interleaving.)
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await erasureTx;
    return duringPromise;
  }

  async function donationCustom(id: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ custom: donations.custom })
      .from(donations)
      .where(and(eq(donations.id, id), eq(donations.orgId, TENANT_ID)));
    return (row?.custom ?? {}) as Record<string, unknown>;
  }

  it("backfill racing an erasure neither re-adds the stripped Art. 9 key nor leaks an undo row", async () => {
    const mergeId = randomUUID();
    await stampMergeMarker(DONATION_DEF_ID, mergeId);

    const result = await withHeldErasureTx(
      async (tx) => {
        // Erasure step 2: strip the sensitive donation key.
        await tx.execute(sql`
          UPDATE donations SET custom = custom - 'gift_reason'
          WHERE id = ${D_MERGE_RACE} AND org_id = ${TENANT_ID}
        `);
      },
      () =>
        processCustomFieldOptionMerge(
          fakeJob({
            orgId: TENANT_ID,
            mergeId,
            definitionId: DONATION_DEF_ID,
            sourceOptionId: SRC,
            targetOptionId: TGT,
            requestedBy: REQUESTED_BY,
          }),
        ),
    );
    // The chunk serialised behind the erasure: nothing matched anymore.
    expect(result).toMatchObject({ status: "completed", rewrittenRows: 0 });

    // The stripped key stays stripped — the backfill never rewrote the
    // wiped blob (the old id-only UPDATE re-added it via create_missing)…
    expect(await donationCustom(D_MERGE_RACE)).toEqual({});
    // …and no undo row postdates the purge carrying the pre-erasure
    // Art. 9 value for 30 days.
    const undoRows = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(eq(customFieldMergeUndo.orgId, TENANT_ID), eq(customFieldMergeUndo.mergeId, mergeId)),
      );
    expect(undoRows).toHaveLength(0);
  });

  it("undo restore racing an erasure never replays purged undo rows onto the erased donation", async () => {
    const mergeId = randomUUID();
    await db.insert(customFieldMergeUndo).values({
      orgId: TENANT_ID,
      definitionId: DONATION_DEF_ID,
      mergeId,
      sourceOptionId: SRC,
      targetOptionId: TGT,
      entityId: D_UNDO_RACE,
      previousValue: SRC,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await withHeldErasureTx(
      async (tx) => {
        // Erasure steps 2 + 3 for the subject's donation: strip the
        // Art. 9 key AND purge its undo rows.
        await tx.execute(sql`
          UPDATE donations SET custom = custom - 'gift_reason'
          WHERE id = ${D_UNDO_RACE} AND org_id = ${TENANT_ID}
        `);
        await tx.execute(sql`
          DELETE FROM custom_field_merge_undo
          WHERE org_id = ${TENANT_ID} AND entity_id = ${D_UNDO_RACE}
        `);
      },
      () =>
        processCustomFieldOptionMergeUndo(
          fakeJob({
            orgId: TENANT_ID,
            mergeId,
            definitionId: DONATION_DEF_ID,
            sourceOptionId: SRC,
            targetOptionId: TGT,
            requestedBy: REQUESTED_BY,
          }),
        ),
    );
    // Consume-first behind the lock: the purged store yields nothing to
    // replay (the old read-then-restore path re-applied the pre-erasure
    // value it had already read, then no-op'd its own delete).
    expect(result).toEqual({ status: "completed", restoredRows: 0, chunks: 0 });
    expect(await donationCustom(D_UNDO_RACE)).toEqual({});
    const remaining = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(eq(customFieldMergeUndo.orgId, TENANT_ID), eq(customFieldMergeUndo.mergeId, mergeId)),
      );
    expect(remaining).toHaveLength(0);
  });
});

describe("processCustomFieldUndoPurge", () => {
  it("deletes only rows past expires_at", async () => {
    const expiredId = randomUUID();
    const freshId = randomUUID();
    await db.insert(customFieldMergeUndo).values([
      {
        id: expiredId,
        orgId: TENANT_ID,
        definitionId: PICKLIST_DEF_ID,
        mergeId: randomUUID(),
        sourceOptionId: SRC,
        targetOptionId: TGT,
        entityId: C_SCALAR,
        previousValue: SRC,
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        id: freshId,
        orgId: TENANT_ID,
        definitionId: PICKLIST_DEF_ID,
        mergeId: randomUUID(),
        sourceOptionId: SRC,
        targetOptionId: TGT,
        entityId: C_SCALAR,
        previousValue: SRC,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const result = await processCustomFieldUndoPurge(fakeJob({}) as Job);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(eq(customFieldMergeUndo.orgId, TENANT_ID));
    const ids = remaining.map((row) => row.id);
    expect(ids).not.toContain(expiredId);
    expect(ids).toContain(freshId);
  });
});
