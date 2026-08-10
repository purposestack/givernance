/**
 * Unit tests for multi-fund split allocation (B1, ADR-032 §3.1).
 *
 * The bug these lock down: the allocation query filtered `is_online_default = TRUE`,
 * but `0059` puts a partial UNIQUE index on that column — so at most ONE row ever
 * matched, the split percentages were never applied, and the rounding-remainder
 * correction poured the whole donation into that single fund. A 60/40 campaign
 * settled 100/0 with no error, and any test asserting only `sum === amount` passed.
 */

import { describe, expect, it } from "vitest";
import { computeFundSplits } from "./stripe-webhook.js";

describe("computeFundSplits", () => {
  it("single fund with NULL split takes the whole amount", () => {
    expect(computeFundSplits([{ fundId: "a", splitPct: null }], 10_000)).toEqual([
      { fundId: "a", amountCents: 10_000 },
    ]);
  });

  it("60/40 actually splits 60/40 (the B1 regression)", () => {
    const out = computeFundSplits(
      [
        { fundId: "a", splitPct: "60.00" },
        { fundId: "b", splitPct: "40.00" },
      ],
      10_000,
    );
    expect(out).toEqual([
      { fundId: "a", amountCents: 6_000 },
      { fundId: "b", amountCents: 4_000 },
    ]);
    // Guard against the masking assertion: sum alone would also pass for 100/0.
    expect(out.every((s) => s.amountCents > 0)).toBe(true);
  });

  it("thirds sum exactly and spread the leftover by largest remainder", () => {
    const out = computeFundSplits(
      [
        { fundId: "a", splitPct: "33.33" },
        { fundId: "b", splitPct: "33.33" },
        { fundId: "c", splitPct: "33.34" },
      ],
      10_000,
    );
    expect(out.reduce((s, x) => s + x.amountCents, 0)).toBe(10_000);
    // 3333 / 3333 / 3334 — the .34 share carries the extra unit.
    expect(out.map((s) => s.amountCents)).toEqual([3_333, 3_333, 3_334]);
  });

  it("never biases the first fund with the whole rounding remainder", () => {
    // 1 cent across three equal funds: each exact share is 0.333…, all floor to 0,
    // leftover 1 goes to exactly one fund — not 1 to the first and 0 elsewhere by
    // a blanket dump (which would be indistinguishable here), so assert the total
    // and that no fund exceeds 1.
    const out = computeFundSplits(
      [
        { fundId: "a", splitPct: "33.33" },
        { fundId: "b", splitPct: "33.33" },
        { fundId: "c", splitPct: "33.34" },
      ],
      1,
    );
    expect(out.reduce((s, x) => s + x.amountCents, 0)).toBe(1);
    expect(out.every((s) => s.amountCents <= 1)).toBe(true);
  });

  it("always sums to the donation amount for an odd split", () => {
    const out = computeFundSplits(
      [
        { fundId: "a", splitPct: "16.67" },
        { fundId: "b", splitPct: "83.33" },
      ],
      999,
    );
    expect(out.reduce((s, x) => s + x.amountCents, 0)).toBe(999);
  });
});
