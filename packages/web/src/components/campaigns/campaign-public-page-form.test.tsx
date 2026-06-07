import { CampaignPublicPageForm } from "@/components/campaigns/campaign-public-page-form";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { mockRouter, render, screen, userEvent, waitFor } from "@/tests/test-utils";

const CAMPAIGN = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "org-1",
  name: "Spring Appeal",
  description: null,
  type: "digital" as const,
  status: "active" as const,
  defaultCurrency: "EUR" as const,
  parentId: null,
  operationalCostCents: null,
  platformFeesCents: 0,
  goalAmountCents: null,
  bankAccountId: null,
  qrReferenceMode: "auto" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("CampaignPublicPageForm", () => {
  it("blocks submission when the goal amount input stays invalid", async () => {
    const user = userEvent.setup();

    const upsertCampaignPublicPage = vi
      .spyOn(CampaignPublicPageService, "upsertCampaignPublicPage")
      .mockResolvedValue({
        id: "44444444-4444-4444-8444-444444444444",
        orgId: "org-1",
        campaignId: "11111111-1111-4111-8111-111111111111",
        title: "Spring Appeal",
        description: null,
        colorPrimary: "#08675b",
        goalAmountCents: null,
        status: "draft",
        publicPageStyle: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

    render(
      <CampaignPublicPageForm
        campaign={{
          id: "11111111-1111-4111-8111-111111111111",
          orgId: "org-1",
          name: "Spring Appeal",
          description: null,
          type: "digital",
          status: "active",
          defaultCurrency: "EUR",
          parentId: null,
          operationalCostCents: null,
          platformFeesCents: 0,
          goalAmountCents: null,
          bankAccountId: null,
          qrReferenceMode: "auto",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        initialPage={null}
        publicPageStylesEnabled={false}
      />,
    );

    const amountInput = screen.getByLabelText("Displayed goal amount");
    await user.type(amountInput, "12.345");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Save public page" }));

    await waitFor(() =>
      expect(
        screen.getByText("Enter a valid amount with no more than two decimal places."),
      ).toBeInTheDocument(),
    );
    expect(upsertCampaignPublicPage).not.toHaveBeenCalled();
    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });

  it("re-enables the 'View public page' link after a successful save (isDirty clears)", async () => {
    const user = userEvent.setup();

    // A published page with no goal — `goalAmountCents: null` is the exact
    // shape that exposed the regression: the resolver drops null goals, so
    // a baseline built from the submit payload never matched the live form
    // and `isDirty` stayed true, leaving the view link disabled until a
    // hard refresh.
    const publishedPage = {
      id: "44444444-4444-4444-8444-444444444444",
      orgId: "org-1",
      campaignId: CAMPAIGN.id,
      title: "Spring Appeal",
      description: null,
      colorPrimary: "#08675b" as const,
      goalAmountCents: null,
      status: "published" as const,
      publicPageStyle: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    // The server returns the CANONICAL persisted record — here with a
    // trimmed title — to prove the re-baseline reads from the response, not
    // from the un-normalised text the user typed locally.
    const upsertCampaignPublicPage = vi
      .spyOn(CampaignPublicPageService, "upsertCampaignPublicPage")
      .mockResolvedValue({ ...publishedPage, title: "Spring Appeal 2026" });

    render(
      <CampaignPublicPageForm
        campaign={CAMPAIGN}
        initialPage={publishedPage}
        publicPageStylesEnabled={false}
      />,
    );

    // Pristine + published → the access affordance is a working link.
    expect(screen.getByRole("link", { name: "View public page" })).toBeInTheDocument();

    // Make a change → form is dirty → link becomes the disabled tooltip button.
    // Type with trailing whitespace the server is expected to trim.
    await user.type(screen.getByLabelText(/Public page title/), " 2026  ");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "View public page" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "View public page" })).toBeDisabled();

    // Save → on success the form re-baselines from the server record,
    // isDirty clears, and the working link returns WITHOUT a page reload.
    await user.click(screen.getByRole("button", { name: "Save public page" }));

    await waitFor(() => expect(upsertCampaignPublicPage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "View public page" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "View public page" })).not.toBeInTheDocument();
    // The editor reflects the server's normalised title, not the raw input.
    expect(screen.getByLabelText(/Public page title/)).toHaveValue("Spring Appeal 2026");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });
});
