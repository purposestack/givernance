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
    const fundCheckbox = await screen.findByRole("checkbox", { name: "Restricted Fund" });
    await user.click(fundCheckbox);
    await waitFor(() => expect(fundCheckbox).toHaveAttribute("data-state", "checked"));
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

  it("exposes the eligible funds as an accessible group", async () => {
    render(<CampaignForm mode="create" />);

    await waitFor(() => expect(FundService.listFunds).toHaveBeenCalled());

    expect(screen.getByRole("group", { name: "Eligible funds" })).toBeInTheDocument();
  });

  it("shows a direct CTA to create a fund when none are configured", async () => {
    vi.spyOn(FundService, "listFunds").mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, perPage: 100, total: 0, totalPages: 0 },
    });

    render(<CampaignForm mode="create" />);

    expect(await screen.findByText("No funds configured yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a fund" })).toHaveAttribute(
      "href",
      "/settings/funds",
    );
  });

  it("blocks editing when campaign fund options fail to load", async () => {
    const user = userEvent.setup();
    vi.spyOn(FundService, "listCampaignFunds").mockRejectedValueOnce(new Error("boom"));
    const updateCampaign = vi
      .spyOn(CampaignService, "updateCampaign")
      .mockResolvedValue(parentCampaign);

    render(<CampaignForm mode="edit" campaign={parentCampaign} />);

    expect(
      await screen.findByText(/Unable to load the related campaigns or funds/i),
    ).toBeInTheDocument();

    const submitButton = screen.getByRole("button", { name: "Save changes" });
    expect(submitButton).toBeDisabled();

    await user.click(submitButton);

    expect(updateCampaign).not.toHaveBeenCalled();
  });
});
