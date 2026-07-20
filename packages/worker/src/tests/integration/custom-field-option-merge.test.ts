/**
 * Option-merge backfill + merge-undo purge integration tests (Epic #539).
 *
 * Pins the pipeline contract:
 *   - stored picklist scalars and multi_picklist arrays are rewritten
 *     source → target (arrays deduped when the row already carried both),
 *   - one `custom_field_merge_undo` row per rewritten entity, holding
 *     ONLY the pre-merge value of the touched key,
 *   - the source option ends `{ active: false, mergedInto: target }`,
 *   - one counts-only audit row (anti-goal #7: no value snapshots),
 *   - idempotent re-run rewrites nothing and duplicates no undo rows,
 *   - flag off ⇒ job dropped untouched (defence in depth),
 *   - the purge cron deletes only expired undo rows.
 */

import { randomUUID } from "node:crypto";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  auditLogs,
  constituents,
  customFieldDefinitions,
  customFieldMergeUndo,
  tenantFlagOverrides,
  tenants,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { processCustomFieldOptionMerge } from "../../processors/custom-field-option-merge.js";
import { processCustomFieldOptionMergeUndo } from "../../processors/custom-field-option-merge-undo.js";
import { processCustomFieldUndoPurge } from "../../processors/custom-field-undo-purge.js";

// Unique per test file — worker suites run in parallel, so sharing a
// tenant id with another file races setup/teardown (23503 on tenant
// delete when a sibling file's audit rows still reference it).
const TENANT_ID = "00000000-0000-0000-0000-000000539001";
const PICKLIST_DEF_ID = "00000000-0000-0000-0000-00000000d539";
const MULTI_DEF_ID = "00000000-0000-0000-0000-00000000e539";
const REQUESTED_BY = "00000000-0000-0000-0000-00000000a539";

const SRC = "opt_srcsrc01";
const TGT = "opt_tgttgt01";
const OTHER = "opt_othoth01";

const C_SCALAR = "00000000-0000-0000-0000-00000000c001";
const C_UNTOUCHED = "00000000-0000-0000-0000-00000000c002";
const C_MULTI = "00000000-0000-0000-0000-00000000c003";
const C_MULTI_DEDUPE = "00000000-0000-0000-0000-00000000c004";

function fakeJob(data: Record<string, unknown>): Job<never> {
  return { id: `test-${randomUUID().slice(0, 8)}`, data } as unknown as Job<never>;
}

async function setFlag(enabled: boolean): Promise<void> {
  await db
    .insert(tenantFlagOverrides)
    .values({
      tenantId: TENANT_ID,
      flagKey: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
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
          ]),
        ),
      );
  } finally {
    await db.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable`);
  }
  await db.delete(customFieldMergeUndo).where(eq(customFieldMergeUndo.orgId, TENANT_ID));
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

  it("rewrites scalar picklist values, writes undo rows, marks the option, audits counts only", async () => {
    const mergeId = randomUUID();
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
    expect(sourceOption).toMatchObject({ active: false, mergedInto: TGT });

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

  it("re-run is idempotent: nothing rewritten, no duplicate undo rows", async () => {
    const mergeId = randomUUID();
    const result = await processCustomFieldOptionMerge(
      fakeJob({
        orgId: TENANT_ID,
        mergeId,
        definitionId: PICKLIST_DEF_ID,
        sourceOptionId: SRC,
        targetOptionId: TGT,
      }),
    );
    expect(result).toEqual({ status: "completed", rewrittenRows: 0, chunks: 0 });
    const undoRows = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(
        and(eq(customFieldMergeUndo.orgId, TENANT_ID), eq(customFieldMergeUndo.mergeId, mergeId)),
      );
    expect(undoRows).toHaveLength(0);
  });

  it("rewrites multi_picklist arrays and dedupes when source and target coexist", async () => {
    const mergeId = randomUUID();
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
