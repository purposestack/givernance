import { CampaignForm } from "@/components/campaigns/campaign-form";
import { ApiProblem } from "@/lib/api";
import type { Campaign } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";
import { FundService } from "@/services/FundService";
import { mockRouter, mockToast, render, screen, userEvent, waitFor } from "../../tests/test-utils";

const parentCampaign: Campaign = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "00000000-0000-0000-0000-0000000000a1",
  name: "Regional Appeal",
  type: "digital",
  status: "active",
  defaultCurrency: "EUR",
  parentId: null,
  operationalCostCents: 35000,
  platformFeesCents: 0,
  goalAmountCents: null,
  createdAt: "2026-04-21T10:00:00.000Z",
  updatedAt: "2026-04-21T10:00:00.000Z",
};

describe("CampaignForm", () => {
  beforeEach(() => {
    vi.spyOn(CampaignService, "listCampaigns").mockResolvedValue({
      data: [parentCampaign],
      pagination: { page: 1, perPage: 100, total: 1, totalPages: 1 },
    });
    vi.spyOn(FundService, "listFunds").mockResolvedValue({
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          orgId: parentCampaign.orgId,
          name: "Restricted Fund",
          description: "Restricted",
          type: "restricted",
          createdAt: parentCampaign.createdAt,
          updatedAt: parentCampaign.updatedAt,
        },
      ],
      pagination: { page: 1, perPage: 100, total: 1, totalPages: 1 },
    });
    vi.spyOn(FundService, "listCampaignFunds").mockResolvedValue([]);
  });

  it("submits trimmed values in create mode", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignService, "createCampaign").mockResolvedValue({
      ...parentCampaign,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Spring Appeal 2026",
      operationalCostCents: 1250,
    });

    render(<CampaignForm mode="create" />);

    await waitFor(() => expect(CampaignService.listCampaigns).toHaveBeenCalled());
    await waitFor(() => expect(FundService.listFunds).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Spring appeal 2026"), "  Spring Appeal 2026  ");
    await user.type(screen.getByPlaceholderText("0.00"), "12.50");
    await user.click(screen.getByRole("checkbox", { name: "Restricted Fund" }));
    await user.click(screen.getByRole("button", { name: "Create campaign" }));

    await waitFor(() =>
      expect(CampaignService.createCampaign).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: "Spring Appeal 2026",
          type: "digital",
          parentId: null,
          operationalCostCents: 1250,
          fundIds: ["33333333-3333-4333-8333-333333333333"],
        }),
      ),
    );

    expect(mockToast.success).toHaveBeenCalledWith("Campaign created.");
    expect(mockRouter.push).toHaveBeenCalledWith("/campaigns/22222222-2222-4222-8222-222222222222");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("surfaces API validation errors at the form level", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignService, "createCampaign").mockRejectedValue(
      new ApiProblem({
        type: "https://givernance.test/problems/validation",
        title: "Validation failed",
        status: 422,
        detail: "Campaign name is already used.",
      }),
    );

    render(<CampaignForm mode="create" />);

    await waitFor(() => expect(CampaignService.listCampaigns).toHaveBeenCalled());
    await waitFor(() => expect(FundService.listFunds).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Spring appeal 2026"), "Existing campaign");
    await user.click(screen.getByRole("button", { name: "Create campaign" }));

    expect(await screen.findByText("Campaign name is already used.")).toBeInTheDocument();
  });
});
