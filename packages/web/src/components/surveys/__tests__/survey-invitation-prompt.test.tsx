/**
 * SurveyInvitationPrompt tests (issue #444).
 *
 * Covers the contract that matters for in-app delivery:
 *   1. Modal renders when /pending returns a PMF invitation; clicking
 *      "Submit" without a selection is a no-op (button disabled).
 *   2. Picking a PMF category → enabling Submit → click POSTs
 *      /respond with the chosen category, then the modal closes.
 *   3. Clicking "Not now" POSTs /dismiss (settles server-side).
 *   4. The PendingSurveyKind discriminator routes to the right input
 *      (NPS 0-10 grid, CSAT 1-5 stars).
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { PendingSurveyInvitation } from "@/models/surveys";

import { SurveyInvitationPrompt } from "../survey-invitation-prompt";

const fetchPending = vi.fn<() => Promise<PendingSurveyInvitation[]>>();
const respond = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const dismiss = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@/services/TenantSurveyService", () => ({
  TenantSurveyService: {
    fetchPending: (...args: unknown[]) => fetchPending(...(args as [])),
    respond: (...args: unknown[]) => respond(...args),
    dismiss: (...args: unknown[]) => dismiss(...args),
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "id"),
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

const pmfInvitation: PendingSurveyInvitation = {
  invitationId: "11111111-1111-4111-8111-111111111111",
  surveyId: "22222222-2222-4222-8222-222222222222",
  surveyKind: "pmf",
  questionFr: "FR question",
  questionEn: "EN question",
  invitedAt: "2026-05-20T00:00:00Z",
  expiresAt: "2026-06-20T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SurveyInvitationPrompt", () => {
  it("renders the EN question for locale=en and disables Submit until a category is picked", async () => {
    fetchPending.mockResolvedValue([pmfInvitation]);
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());
    const submit = screen.getByRole("button", { name: /^submit$/i });
    expect(submit).toBeDisabled();
  });

  it("POSTs /respond with the chosen PMF category, then closes the modal", async () => {
    // After submit the component calls refresh() to chain into the
    // next pending invitation; mock the second fetch as empty so the
    // modal unmounts (mirrors real-server behaviour where the
    // just-responded invitation now has opened_at set and is
    // excluded by /pending).
    fetchPending.mockResolvedValueOnce([pmfInvitation]).mockResolvedValue([]);
    respond.mockResolvedValue({});
    const user = userEvent.setup();
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());

    await user.click(screen.getByLabelText("pmfVeryDisappointed"));
    await user.click(screen.getByRole("button", { name: /^submit$/i }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith({}, pmfInvitation.invitationId, {
      response: { category: "very_disappointed" },
    });
    // Once the response succeeds the modal unmounts (no more EN question).
    await waitFor(() => expect(screen.queryByText("EN question")).toBeNull());
  });

  it("chains into the next pending invitation after submit (#444 follow-up)", async () => {
    // Two pending; submit the first → refresh fires immediately →
    // the second one appears without waiting for the 60s poll. Real
    // server would have set opened_at on the first by now, so we
    // simulate that by returning only the second on the next fetch.
    const second: PendingSurveyInvitation = {
      ...pmfInvitation,
      invitationId: "33333333-3333-4333-8333-333333333333",
      surveyKind: "nps",
      questionEn: "Second question",
    };
    fetchPending.mockResolvedValueOnce([pmfInvitation, second]).mockResolvedValueOnce([second]);
    respond.mockResolvedValue({});
    const user = userEvent.setup();
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());

    await user.click(screen.getByLabelText("pmfVeryDisappointed"));
    await user.click(screen.getByRole("button", { name: /^submit$/i }));

    // Second question surfaces immediately (no 60s wait).
    await waitFor(() => expect(screen.getByText("Second question")).toBeInTheDocument());
  });

  it("clicking 'Don't ask again' POSTs /dismiss to settle the invitation server-side", async () => {
    fetchPending.mockResolvedValueOnce([pmfInvitation]).mockResolvedValue([]);
    dismiss.mockResolvedValue({});
    const user = userEvent.setup();
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^dismiss$/i }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    expect(dismiss).toHaveBeenCalledWith({}, pmfInvitation.invitationId);
  });

  it("clicking 'Later' soft-closes locally — no /dismiss POST, modal unmounts", async () => {
    // "Plus tard" must NOT settle the invitation server-side — it
    // just suppresses the modal for this session via suppressedIds.
    // The server row stays open so the next login / page refresh
    // re-surfaces it, matching what "Later" implies.
    fetchPending.mockResolvedValue([pmfInvitation]);
    const user = userEvent.setup();
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^notNow$/i }));

    expect(dismiss).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("EN question")).toBeNull());
  });

  it("renders the 0-10 NPS grid for surveyKind='nps'", async () => {
    fetchPending.mockResolvedValue([{ ...pmfInvitation, surveyKind: "nps" }]);
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());
    // 11 native <input type="radio"> (one per score 0..10).
    expect(screen.getAllByRole("radio")).toHaveLength(11);
  });

  it("renders the 1-5 CSAT stars for surveyKind='csat'", async () => {
    fetchPending.mockResolvedValue([{ ...pmfInvitation, surveyKind: "csat" }]);
    render(<SurveyInvitationPrompt locale="en" />);
    await waitFor(() => expect(screen.getByText("EN question")).toBeInTheDocument());
    // 5 native <input type="radio"> + visible "N ★" label spans.
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByText("1 ★")).toBeInTheDocument();
    expect(screen.getByText("5 ★")).toBeInTheDocument();
  });
});
