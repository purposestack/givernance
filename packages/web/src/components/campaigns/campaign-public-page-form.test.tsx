import { CampaignPublicPageForm } from "@/components/campaigns/campaign-public-page-form";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { mockRouter, render, screen, userEvent, waitFor } from "@/tests/test-utils";

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
        colorPrimary: "#096447",
        goalAmountCents: null,
        status: "draft",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

    render(
      <CampaignPublicPageForm
        campaign={{
          id: "11111111-1111-4111-8111-111111111111",
          orgId: "org-1",
          name: "Spring Appeal",
          type: "digital",
          status: "active",
          defaultCurrency: "EUR",
          parentId: null,
          costCents: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        initialPage={null}
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
});
