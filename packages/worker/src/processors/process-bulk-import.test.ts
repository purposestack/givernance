/**
 * Unit coverage for the bulk-import multi-type gate (issue #465).
 *
 * `processOneRow` is the second wall behind the API's `requireFlag` 404 +
 * the route-level `rejectMultiTypeWhenDisabled` 422. This test pins the
 * off-state contract — a multi-valued `type` cell is REJECTED as a failed
 * row with the `multi_type_disabled` code (parity with the API), never
 * silently truncated — and the on-state — both types are persisted.
 *
 * Pure-function style: a stubbed `tx` records the inserts. The reject path
 * returns before any DB dup-check, so no real Postgres is needed.
 */

import {
  buildCustomHeaderResolver,
  buildCustomValidator,
  type CustomFieldDefinition,
} from "@givernance/shared/custom-fields";
import { describe, expect, it, vi } from "vitest";
import {
  DuplicateCustomColumnError,
  parseCsvBuffer,
  processOneRow,
  type RowContext,
} from "./process-bulk-import.js";

interface CapturedInsert {
  vals: Record<string, unknown>;
}

/**
 * Minimal Drizzle-tx stub. `insert(table).values(obj)` is awaitable AND
 * exposes `.returning()` (the created-row path chains it); both resolve to a
 * single fake id. `execute()` backs `findDuplicate` — empty rows = no dup.
 */
function makeTx(captured: CapturedInsert[]) {
  return {
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        captured.push({ vals });
        const p: Promise<Array<{ id: string }>> & {
          returning?: () => Promise<Array<{ id: string }>>;
        } = Promise.resolve([{ id: "new-id" }]);
        p.returning = () => Promise.resolve([{ id: "new-id" }]);
        return p;
      },
    }),
    execute: async () => ({ rows: [] }),
  };
}

function makeCtx(
  multiTypeEnabled: boolean,
  typeCell: string,
  options?: {
    customFields?: RowContext["customFields"];
    extraValues?: Record<string, string>;
  },
): { ctx: RowContext; captured: CapturedInsert[] } {
  const captured: CapturedInsert[] = [];
  const ctx = {
    tx: makeTx(captured),
    row: {
      rowNumber: 1,
      values: {
        firstName: "Alice",
        lastName: "Martin",
        type: typeCell,
        ...options?.extraValues,
      },
    },
    orgId: "00000000-0000-0000-0000-0000000000aa",
    jobId: "00000000-0000-0000-0000-0000000000bb",
    batchDelta: {
      processed: 0,
      created: 0,
      duplicate: 0,
      failed: 0,
      emailWithValue: 0,
      completeAddress: 0,
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    multiTypeEnabled,
    customFields: options?.customFields ?? null,
  } as unknown as RowContext;
  return { ctx, captured };
}

describe("processOneRow — multi-type gate (issue #465)", () => {
  it("flag OFF: rejects a multi-valued type cell with multi_type_disabled, persists no constituent", async () => {
    const { ctx, captured } = makeCtx(false, "donor;volunteer");
    await processOneRow(ctx);

    // Exactly one insert — the failed result row — and no constituent insert.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.vals).toMatchObject({
      status: "failed",
      errorCode: "multi_type_disabled",
    });
    expect(ctx.batchDelta.failed).toBe(1);
    expect(ctx.batchDelta.created).toBe(0);
    // No row was written with a multi-element `types` array.
    expect(captured.some((c) => Array.isArray(c.vals.types))).toBe(false);
  });

  it("flag OFF: a single-type cell still imports normally", async () => {
    const { ctx, captured } = makeCtx(false, "donor");
    await processOneRow(ctx);

    expect(ctx.batchDelta.failed).toBe(0);
    expect(ctx.batchDelta.created).toBe(1);
    const constituentInsert = captured.find((c) => Array.isArray(c.vals.types));
    expect(constituentInsert?.vals.types).toEqual(["donor"]);
    expect(constituentInsert?.vals.type).toBe("donor");
  });

  it("flag ON: persists all types from a multi-valued cell (type === types[0])", async () => {
    const { ctx, captured } = makeCtx(true, "donor;volunteer");
    await processOneRow(ctx);

    expect(ctx.batchDelta.failed).toBe(0);
    expect(ctx.batchDelta.created).toBe(1);
    const constituentInsert = captured.find((c) => Array.isArray(c.vals.types));
    expect(constituentInsert?.vals.types).toEqual(["donor", "volunteer"]);
    // Back-compat shadow: legacy scalar column tracks types[0].
    expect(constituentInsert?.vals.type).toBe("donor");
  });
});

/**
 * Epic #539 — custom-field cells in the import pipeline. Same stub-tx
 * style: the coercion + validation reject paths return before any DB
 * dup-check, and the accept path shows on the captured constituent
 * insert.
 */
describe("processOneRow — custom-field cells (Epic #539)", () => {
  const segmentDef: CustomFieldDefinition = {
    id: "def-1",
    domain: "constituent",
    key: "donor_segment",
    label: "Segment donateur",
    description: null,
    type: "picklist",
    options: [
      { id: "opt_aaaaaaaa", label: "Grand donateur", active: true, sortOrder: 0 },
      { id: "opt_bbbbbbbb", label: "Ami", active: true, sortOrder: 1 },
    ],
    sortOrder: 0,
    required: false,
    filterable: true,
    exportable: true,
    showOnRelated: false,
    sensitive: false,
    purposeText: null,
  };
  const customFields = {
    defs: [segmentDef],
    validator: buildCustomValidator([segmentDef]),
  };

  it("persists a resolved picklist label as its option id on the created constituent", async () => {
    const { ctx, captured } = makeCtx(true, "donor", {
      customFields,
      extraValues: { cf_donor_segment: "grand DONATEUR" },
    });
    await processOneRow(ctx);

    expect(ctx.batchDelta.failed).toBe(0);
    expect(ctx.batchDelta.created).toBe(1);
    const constituentInsert = captured.find((c) => Array.isArray(c.vals.types));
    expect(constituentInsert?.vals.custom).toEqual({ donor_segment: "opt_aaaaaaaa" });
  });

  it("rejects an unknown picklist value as a failed row — never auto-creates an option", async () => {
    const { ctx, captured } = makeCtx(true, "donor", {
      customFields,
      extraValues: { cf_donor_segment: "Nouveau segment" },
    });
    await processOneRow(ctx);

    expect(ctx.batchDelta.created).toBe(0);
    expect(ctx.batchDelta.failed).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.vals).toMatchObject({
      status: "failed",
      errorCode: "UNKNOWN_CUSTOM_OPTION",
    });
  });

  it("rejects a file carrying BOTH the label header and cf_<key> for one definition (review m12)", () => {
    const resolver = buildCustomHeaderResolver([segmentDef]);
    const csv = [
      "firstName,lastName,Segment donateur,cf_donor_segment",
      "Alice,Martin,Grand donateur,Ami",
    ].join("\n");

    // Last-non-empty-cell-wins would be silently nondeterministic — the
    // whole file is rejected with a per-file error naming the definition.
    let thrown: unknown;
    try {
      parseCsvBuffer(Buffer.from(csv), resolver);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DuplicateCustomColumnError);
    const dup = thrown as DuplicateCustomColumnError;
    expect(dup.code).toBe("DUPLICATE_CUSTOM_COLUMN");
    expect(dup.keys).toEqual(["donor_segment"]);
    // Message names the definition key only — never cell content.
    expect(dup.message).toContain("donor_segment");
    expect(dup.message).not.toContain("Grand donateur");
  });

  it("accepts one column per definition — alias-only and label-only both parse", () => {
    const resolver = buildCustomHeaderResolver([segmentDef]);
    const aliasOnly = parseCsvBuffer(
      Buffer.from("firstName,lastName,cf_donor_segment\nAlice,Martin,Ami\n"),
      resolver,
    );
    expect(aliasOnly[0]?.values.cf_donor_segment).toBe("Ami");

    const labelOnly = parseCsvBuffer(
      Buffer.from("firstName,lastName,Segment donateur\nAlice,Martin,Ami\n"),
      resolver,
    );
    expect(labelOnly[0]?.values.cf_donor_segment).toBe("Ami");
  });

  it("with custom fields off (null resolver), duplicate custom headers are simply dropped", () => {
    const csv = "firstName,lastName,Segment donateur,cf_donor_segment\nAlice,Martin,X,Y\n";
    const rows = parseCsvBuffer(Buffer.from(csv), null);
    expect(rows[0]?.values).toEqual({ firstName: "Alice", lastName: "Martin" });
  });

  it("ignores cf_ cells when custom fields are off for the tenant (customFields null)", async () => {
    const { ctx, captured } = makeCtx(true, "donor", {
      customFields: null,
      extraValues: { cf_donor_segment: "Grand donateur" },
    });
    await processOneRow(ctx);

    expect(ctx.batchDelta.created).toBe(1);
    const constituentInsert = captured.find((c) => Array.isArray(c.vals.types));
    expect(constituentInsert?.vals.custom).toBeUndefined();
  });
});
