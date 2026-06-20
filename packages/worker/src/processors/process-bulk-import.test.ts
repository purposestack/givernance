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

import { describe, expect, it, vi } from "vitest";
import { processOneRow, type RowContext } from "./process-bulk-import.js";

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
): { ctx: RowContext; captured: CapturedInsert[] } {
  const captured: CapturedInsert[] = [];
  const ctx = {
    tx: makeTx(captured),
    row: {
      rowNumber: 1,
      values: { firstName: "Alice", lastName: "Martin", type: typeCell },
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
