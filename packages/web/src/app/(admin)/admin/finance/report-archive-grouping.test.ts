import { describe, expect, it } from "vitest";

import type { MonthlyReport } from "@/models/superadmin-finance";
import { groupReportsByYear } from "./report-archive-grouping";

function report(month: string): MonthlyReport {
  return {
    id: `id-${month}`,
    month,
    status: "ready",
    failureReason: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    readyAt: "2026-06-01T00:00:00.000Z",
    pdfUrl: `/v1/superadmin/finance/reports/id-${month}/pdf`,
  };
}

describe("groupReportsByYear", () => {
  it("buckets reports into descending year groups with months descending inside", () => {
    const groups = groupReportsByYear([report("2026-05"), report("2026-01"), report("2025-12")]);

    expect(groups.map((g) => g.year)).toEqual(["2026", "2025"]);
    expect(groups[0]?.items.map((r) => r.month)).toEqual(["2026-05", "2026-01"]);
    expect(groups[1]?.items.map((r) => r.month)).toEqual(["2025-12"]);
  });

  it("preserves chronological order, never alphabetical-by-month-name", () => {
    // Avril (04) must come before Janvier (01) within 2026 — a name-based
    // sort would invert them.
    const groups = groupReportsByYear([report("2026-04"), report("2026-01")]);
    expect(groups[0]?.items.map((r) => r.month)).toEqual(["2026-04", "2026-01"]);
  });

  it("defensively re-sorts so a year never splits into two bands when input is unordered", () => {
    // Upstream contract is `month DESC`; if it ever drifts, a naive linear
    // pass would emit 2026 → 2025 → 2026. The defensive sort prevents that.
    const groups = groupReportsByYear([report("2026-05"), report("2025-12"), report("2026-03")]);

    expect(groups.map((g) => g.year)).toEqual(["2026", "2025"]);
    expect(groups[0]?.items.map((r) => r.month)).toEqual(["2026-05", "2026-03"]);
  });

  it("returns an empty array for no reports", () => {
    expect(groupReportsByYear([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [report("2025-01"), report("2026-01")];
    const snapshot = input.map((r) => r.month);
    groupReportsByYear(input);
    expect(input.map((r) => r.month)).toEqual(snapshot);
  });
});
