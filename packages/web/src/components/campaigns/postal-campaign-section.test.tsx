/**
 * UI tests for the postal-campaign workspace (Epic #274 audit follow-up).
 *
 * `PostalCampaignSection` is the client wrapper that owns the shared
 * "linked constituent count" between the members card and the export
 * panel. The interesting behaviours to lock down are:
 *
 *   1. Readiness gates (campaign not active / public page draft / missing)
 *      block the "Generate ZIP" CTA — defence-in-depth alongside the API
 *      contract; if the UI shipped without the gate a click would just
 *      400 from the server, but the operator wouldn't get a useful hint.
 *   2. The "Personalized" mode is locked when `linkedConstituentCount=0`
 *      and unlocks after the operator adds a recipient — the bug that
 *      motivated extracting this wrapper component in the first place.
 *   3. Clicking Generate calls `PostalCampaignService.startExport` and
 *      surfaces a success toast.
 *   4. Clicking Generate while the API rejects with 400 surfaces the
 *      problem detail to the operator (no silent failure).
 *
 * The members-card / dialog plumbing is covered indirectly here — we
 * stub out `PostalCampaignService` and exercise the export panel from
 * the wrapper's perspective.
 */

import { PostalCampaignSection } from "@/components/campaigns/postal-campaign-section";
import { ApiProblem } from "@/lib/api";
import { PostalCampaignService } from "@/services/PostalCampaignService";
import { mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

function renderSection(overrides: Partial<Parameters<typeof PostalCampaignSection>[0]> = {}) {
  return render(
    <PostalCampaignSection
      campaignId={CAMPAIGN_ID}
      campaignType="nominative_postal"
      campaignStatus="active"
      publicPageStatus="published"
      bankAccount={null}
      initialMembers={[]}
      initialMemberTotal={0}
      initialExports={[]}
      {...overrides}
    />,
  );
}

describe("PostalCampaignSection", () => {
  it("disables Generate ZIP and shows the readiness banner when the campaign is still a draft", () => {
    renderSection({ campaignStatus: "draft" });

    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).toBeDisabled();

    expect(screen.getByText(/Activate the campaign first/i)).toBeInTheDocument();
  });

  it("disables Generate ZIP and shows the not-configured banner when no page AND no bank are configured", () => {
    // Epic #318 PR #4 — when both rails are off, the resolved mode is
    // `blocked` and the operator sees the disambiguated notConfigured
    // banner instead of the misleading "configure a public page" hint
    // (their actual intent might be Swiss QR-bill only).
    renderSection({ publicPageStatus: "missing", bankAccount: null });

    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).toBeDisabled();

    expect(screen.getByText(/Postal export not configured/i)).toBeInTheDocument();
    // Banner offers two CTAs: publish the public page OR link a bank account.
    expect(screen.getByRole("link", { name: /Publish a public donation page/i })).toHaveAttribute(
      "href",
      `/campaigns/${CAMPAIGN_ID}/public-page`,
    );
    expect(screen.getByRole("link", { name: /Link a Swiss bank account/i })).toHaveAttribute(
      "href",
      `/campaigns/${CAMPAIGN_ID}/edit`,
    );
  });

  it("disables Generate ZIP and shows the publish-page banner when the page is a draft", () => {
    renderSection({ publicPageStatus: "draft" });

    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).toBeDisabled();
    expect(screen.getByText(/Publish your public donation page first/i)).toBeInTheDocument();
  });

  it("locks the Personalized mode when zero constituents are linked", () => {
    renderSection({ initialMemberTotal: 0 });

    // The mode toggle is rendered as a <button aria-pressed=…> — disabled
    // because the operator has nothing to send a personalized letter to.
    const personalizedToggle = screen.getByRole("button", { name: /Personalized/i });
    expect(personalizedToggle).toBeDisabled();
    expect(personalizedToggle).toHaveAttribute("aria-pressed", "true");

    // Door-drop stays clickable because it doesn't need a recipient list.
    const doorDropToggle = screen.getByRole("button", { name: /Door drop/i });
    expect(doorDropToggle).not.toBeDisabled();
  });

  it("starts a personalized export and surfaces a success toast", async () => {
    const user = userEvent.setup();

    vi.spyOn(PostalCampaignService, "startExport").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      campaignId: CAMPAIGN_ID,
      mode: "personalized",
      status: "pending",
      totalCount: 3,
      progressCount: 0,
      zipS3Path: null,
      error: null,
      requestedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    });

    renderSection({ initialMemberTotal: 3 });

    // With 3 members linked and an active+published campaign, the
    // Generate button is enabled and defaults to personalized mode.
    const generateBtn = screen.getByRole("button", { name: /Generate.*ZIP/i });
    expect(generateBtn).not.toBeDisabled();

    await user.click(generateBtn);

    await waitFor(() =>
      expect(PostalCampaignService.startExport).toHaveBeenCalledWith(
        expect.anything(),
        CAMPAIGN_ID,
        "personalized",
      ),
    );
    expect(mockToast.success).toHaveBeenCalledWith(
      "Export queued — generation will start shortly.",
    );
  });

  it("surfaces a useful error toast when the API rejects the export request", async () => {
    const user = userEvent.setup();

    vi.spyOn(PostalCampaignService, "startExport").mockRejectedValue(
      new ApiProblem({
        type: "https://givernance.test/problems/no_recipients",
        title: "no_recipients",
        status: 400,
        detail: "Add constituents before queueing a personalized export.",
      }),
    );

    renderSection({ initialMemberTotal: 1 });

    await user.click(screen.getByRole("button", { name: /Generate.*ZIP/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        "Add constituents before queueing a personalized export.",
      ),
    );
  });

  it("forces door-drop mode and hides personalized affordance for door-drop campaigns", () => {
    renderSection({ campaignType: "door_drop", initialMemberTotal: 0 });

    // The personalized toggle is rendered but disabled with the
    // door-drop hint copy. The user cannot lift the disabled state via
    // a no-op click.
    const personalizedToggle = screen.getByRole("button", { name: /Personalized/i });
    expect(personalizedToggle).toBeDisabled();
    expect(
      screen.getByText(/Personalized letters are not available for door-drop campaigns/i),
    ).toBeInTheDocument();
  });
});
