/**
 * SurveyLaunchCard tests (issue #444).
 *
 * Covers the contract that matters for the manual-launch UX:
 *   1. Each click mints a fresh UUID v4 Idempotency-Key (server's
 *      cooldown dedupe only works if the caller hands over the key).
 *   2. Successful 202 → success toast with recipient count.
 *   3. 429 → toast surfaces the cooldown in human terms (minutes),
 *      reading the `retry_after_seconds` extension off the
 *      RFC 9457 problem body.
 *   4. The cadence dialog wires its selected radio value through to
 *      `onSchedule(slug, cadence)`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ApiProblem } from "@/lib/api/problem";
import type { SurveyRow } from "@/models/superadmin-finance";

import { SurveyLaunchCard, type SurveyLaunchCardLabels } from "../survey-launch-card";

vi.mock("../toast", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Pull the mocked module back so we can assert on calls.
const toastModule = await import("../toast");

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const labels: SurveyLaunchCardLabels = {
  title: "Survey campaigns",
  subtitle: "Force-send a survey ahead of cadence.",
  pmfLabel: "PMF",
  npsLabel: "NPS",
  csatLabel: "CSAT",
  responseCount: (count) => `${count} responses`,
  lastCollectedAt: (date) => `last ${date}`,
  lastCollectedNever: "no response",
  nextScheduledAt: (date) => `next ${date}`,
  nextScheduledNever: "no cadence",
  launchEmail: "Send email now",
  launchInApp: "Activate in-app",
  changeCadence: "Change cadence",
  toastLaunching: "sending…",
  toastLaunched: (n) => `sent to ${n}`,
  toastCooldown: (m) => `cooldown ${m}m`,
  toastError: (d) => `error ${d}`,
  cadenceDialogTitle: (s) => `Cadence — ${s}`,
  cadenceDialogBody: "Pick a cadence.",
  cadenceOptionQuarterly: "Quarterly",
  cadenceOptionMonthly: "Monthly",
  cadenceOptionContinuous: "Continuous",
  cadenceDialogCancel: "Cancel",
  cadenceDialogConfirm: "Apply",
  cadenceToastUpdated: "cadence ok",
  cadenceToastError: (d) => `cadence err ${d}`,
};

const surveys: SurveyRow[] = [
  {
    kind: "pmf",
    slug: "pmf-sean-ellis",
    lastCollectedAt: "2026-02-01T00:00:00.000Z",
    nextScheduledAt: "2026-05-01T00:00:00.000Z",
    responseCount: 38,
    invitedCount: 100,
    pmfPercent: 42,
    npsScore: null,
    csatScore: null,
    isStatisticallySignificant: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SurveyLaunchCard", () => {
  it("mints a fresh UUID v4 Idempotency-Key per click and surfaces success", async () => {
    const onLaunch = vi.fn(async () => ({ recipientCount: 12 }));
    const user = userEvent.setup();
    render(
      <SurveyLaunchCard
        surveys={surveys}
        labels={labels}
        onLaunch={onLaunch}
        onSchedule={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Send email now/i }));

    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(onLaunch).toHaveBeenCalledWith(
      "pmf-sean-ellis",
      "email",
      expect.stringMatching(UUID_V4_RE),
    );
    expect(toastModule.toast.success).toHaveBeenCalledWith("sent to 12", { id: "toast-id" });
  });

  it("translates a 429 ApiProblem into a human cooldown toast (minutes)", async () => {
    const onLaunch = vi.fn(async () => {
      throw new ApiProblem({
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        detail: "cooldown",
        retry_after_seconds: 3600,
      });
    });
    const user = userEvent.setup();
    render(
      <SurveyLaunchCard
        surveys={surveys}
        labels={labels}
        onLaunch={onLaunch}
        onSchedule={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Send email now/i }));
    await waitFor(() => expect(toastModule.toast.error).toHaveBeenCalled());
    expect(toastModule.toast.error).toHaveBeenCalledWith("cooldown 60m", { id: "toast-id" });
  });

  it("passes the selected cadence radio through to onSchedule", async () => {
    const onSchedule = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <SurveyLaunchCard
        surveys={surveys}
        labels={labels}
        onLaunch={vi.fn()}
        onSchedule={onSchedule}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Change cadence/i }));

    // Default is quarterly_minus_7d for PMF — flip to monthly and confirm.
    const monthly = await screen.findByLabelText("Monthly");
    await user.click(monthly);
    await user.click(screen.getByRole("button", { name: /Apply/i }));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    expect(onSchedule).toHaveBeenCalledWith("pmf-sean-ellis", "monthly");
    expect(toastModule.toast.success).toHaveBeenCalledWith("cadence ok");
  });
});
