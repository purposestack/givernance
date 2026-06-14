/**
 * Unit tests for `processPlatformReportAutoTrigger` — the thin worker
 * adapter around the shared monthly-report request flow (issue #443).
 *
 * No DB / Redis / BullMQ: the shared `requestMonthlyReport` /
 * `backfillLast12Months` are mocked so the adapter's branching (single
 * vs. backfill mode) is verified in isolation. `previousMonth` is kept
 * real (it's pure) so the single-mode month assertion is meaningful.
 */

import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMonthlyReport = vi.fn();
const backfillLast12Months = vi.fn();

vi.mock("@givernance/shared/finance/reporting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@givernance/shared/finance/reporting")>();
  return {
    ...actual,
    requestMonthlyReport,
    backfillLast12Months,
  };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted, but the
// dynamic import keeps intent explicit).
const { processPlatformReportAutoTrigger } = await import("./platform-report-trigger.js");
const { previousMonth } = await import("@givernance/shared/finance/reporting");

function jobFor(data: { mode?: "single" | "backfill" }): Job {
  return { id: "test-job", data } as unknown as Job;
}

describe("processPlatformReportAutoTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestMonthlyReport.mockResolvedValue({
      row: { id: "report-1", month: previousMonth(), status: "pending" },
      replayed: false,
      snapshot: null,
    });
    backfillLast12Months.mockResolvedValue({ enqueued: [], skipped: [] });
  });

  it("single mode → requestMonthlyReport once for the previous month", async () => {
    await processPlatformReportAutoTrigger(jobFor({ mode: "single" }));

    expect(requestMonthlyReport).toHaveBeenCalledTimes(1);
    expect(backfillLast12Months).not.toHaveBeenCalled();
    expect(requestMonthlyReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        month: previousMonth(),
        requestedByPlatformAdminId: null,
      }),
    );
  });

  it("default mode (no mode field) → treated as single", async () => {
    await processPlatformReportAutoTrigger(jobFor({}));

    expect(requestMonthlyReport).toHaveBeenCalledTimes(1);
    expect(backfillLast12Months).not.toHaveBeenCalled();
  });

  it("backfill mode → backfillLast12Months once", async () => {
    await processPlatformReportAutoTrigger(jobFor({ mode: "backfill" }));

    expect(backfillLast12Months).toHaveBeenCalledTimes(1);
    expect(requestMonthlyReport).not.toHaveBeenCalled();
    expect(backfillLast12Months).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestedByPlatformAdminId: null }),
    );
  });
});
