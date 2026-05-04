/**
 * Pure unit tests for the export service helpers (Epic #274).
 *
 * The DB-touching paths (`createExportJob`, `getExportJobView`,
 * `listCampaignExportJobs`) are exercised by the Postgres-backed
 * integration tests in `tests/integration/campaign-exports.test.ts`. This
 * file only covers the standalone math + branching helpers.
 */

import { describe, expect, it } from "vitest";
import { computeProgressPct } from "./exports-service.js";

describe("computeProgressPct", () => {
  it("returns 0 when total is 0", () => {
    expect(computeProgressPct(0, 0)).toBe(0);
  });

  it("returns 0 when total is negative (defensive — should never happen)", () => {
    expect(computeProgressPct(-1, 5)).toBe(0);
  });

  it("returns 50 when half the work is done", () => {
    expect(computeProgressPct(10, 5)).toBe(50);
  });

  it("rounds down to keep the bar from overshooting", () => {
    // 7/10 → 70%, exact. 7/9 → 77.7…, must floor to 77 not ceil to 78.
    expect(computeProgressPct(9, 7)).toBe(77);
  });

  it("caps at 100 even when done > total (defensive)", () => {
    // CHECK constraint enforces done <= total at the DB layer, but the
    // helper guards against partial progress writes that haven't yet
    // been compared against the total.
    expect(computeProgressPct(10, 25)).toBe(100);
  });

  it("returns 100 for an exactly complete job", () => {
    expect(computeProgressPct(10, 10)).toBe(100);
  });
});
