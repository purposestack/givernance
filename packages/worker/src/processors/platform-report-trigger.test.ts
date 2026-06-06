/**
 * Unit tests for `processPlatformReportAutoTrigger` — the thin worker
 * adapter around the shared monthly-report request flow (issue #443).
 *
 * No DB / Redis / BullMQ: the shared `requestMonthlyReport` /
 * `backfillLast12Months` and the `isFlagEnabled` gate are mocked so the
 * adapter's branching (flag-gate, single vs. backfill mode) is verified
 * in isolation. `previousMonth` is kept real (it's pure) so the
 * single-mode month assertion is meaningful.
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

const isFlagEnabled = vi.fn();
vi.mock("../lib/flags.js", () => ({ isFlagEnabled }));

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

  it("flag off → no-op (neither request nor backfill called)", async () => {
    isFlagEnabled.mockResolvedValue(false);

    await processPlatformReportAutoTrigger(jobFor({ mode: "single" }));

    expect(requestMonthlyReport).not.toHaveBeenCalled();
    expect(backfillLast12Months).not.toHaveBeenCalled();
  });

  it("single mode (flag on) → requestMonthlyReport once for the previous month", async () => {
    isFlagEnabled.mockResolvedValue(true);

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
    isFlagEnabled.mockResolvedValue(true);

    await processPlatformReportAutoTrigger(jobFor({}));

    expect(requestMonthlyReport).toHaveBeenCalledTimes(1);
    expect(backfillLast12Months).not.toHaveBeenCalled();
  });

  it("backfill mode (flag on) → backfillLast12Months once", async () => {
    isFlagEnabled.mockResolvedValue(true);

    await processPlatformReportAutoTrigger(jobFor({ mode: "backfill" }));

    expect(backfillLast12Months).toHaveBeenCalledTimes(1);
    expect(requestMonthlyReport).not.toHaveBeenCalled();
    expect(backfillLast12Months).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestedByPlatformAdminId: null }),
    );
  });
});
