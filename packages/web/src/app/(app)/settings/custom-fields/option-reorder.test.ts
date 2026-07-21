import { describe, expect, it } from "vitest";
import type { CustomFieldOption } from "@/models/custom-field";
import { planOptionMove, sortOptionsByOrder } from "./option-reorder";

function opt(id: string, sortOrder: number, extra?: Partial<CustomFieldOption>): CustomFieldOption {
  return { id, label: id, active: true, sortOrder, ...extra };
}

describe("planOptionMove", () => {
  // PR #550 MAJOR-5 regression: the API persists exactly the sortOrder it is
  // given (no sibling renumbering), so the plan must renumber contiguously
  // and name every option whose stored sortOrder changed.
  it("adjacent move down: renumbers both affected options, no duplicates", () => {
    const options = [opt("a", 0), opt("b", 1), opt("c", 2)];
    const plan = planOptionMove(options, 0, 1);
    expect(plan).not.toBeNull();
    expect(plan?.ordered.map((o) => o.id)).toEqual(["b", "a", "c"]);
    expect(plan?.ordered.map((o) => o.sortOrder)).toEqual([0, 1, 2]);
    // Exactly the two swapped options are persisted — c is untouched.
    expect(plan?.changed).toEqual([
      { id: "b", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
    ]);
    // The resulting sortOrders are unique (the original bug produced dupes).
    const orders = plan?.ordered.map((o) => o.sortOrder) ?? [];
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("adjacent move up mirrors the swap", () => {
    const options = [opt("a", 0), opt("b", 1), opt("c", 2)];
    const plan = planOptionMove(options, 2, -1);
    expect(plan?.ordered.map((o) => o.id)).toEqual(["a", "c", "b"]);
    expect(plan?.changed).toEqual([
      { id: "c", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("returns null when the move is out of bounds", () => {
    const options = [opt("a", 0), opt("b", 1)];
    expect(planOptionMove(options, 0, -1)).toBeNull();
    expect(planOptionMove(options, 1, 1)).toBeNull();
    expect(planOptionMove([], 0, 1)).toBeNull();
  });

  it("self-heals a list corrupted with duplicate sortOrders", () => {
    // Pre-fix state: repeated single-PATCH moves accumulated duplicates.
    const options = [opt("a", 1), opt("b", 1), opt("c", 1)];
    const plan = planOptionMove(options, 1, 1);
    expect(plan?.ordered.map((o) => o.id)).toEqual(["a", "c", "b"]);
    expect(plan?.ordered.map((o) => o.sortOrder)).toEqual([0, 1, 2]);
    // Every option whose stored sortOrder differs from its new one is fixed.
    expect(plan?.changed).toEqual([
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("preserves non-sortOrder option fields (merge markers survive)", () => {
    const options = [opt("a", 0), opt("b", 1, { active: false, mergedInto: "a" })];
    const plan = planOptionMove(options, 1, -1);
    const movedB = plan?.ordered.find((o) => o.id === "b");
    expect(movedB).toMatchObject({ active: false, mergedInto: "a", sortOrder: 0 });
  });
});

describe("sortOptionsByOrder", () => {
  it("orders by persisted sortOrder without mutating the input", () => {
    const options = [opt("b", 2), opt("a", 0), opt("c", 1)];
    expect(sortOptionsByOrder(options).map((o) => o.id)).toEqual(["a", "c", "b"]);
    expect(options.map((o) => o.id)).toEqual(["b", "a", "c"]);
  });
});
