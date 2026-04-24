import { DonationForm } from "@/components/donations/donation-form";
import { CampaignService } from "@/services/CampaignService";
import { ConstituentService } from "@/services/ConstituentService";
import { DonationService } from "@/services/DonationService";
import { mockRouter, mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

describe("DonationForm", () => {
  it("creates a donation after selecting a constituent and entering a valid amount", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignService, "listCampaigns").mockResolvedValue({
      data: [],
      pagination: { page: 1, perPage: 100, total: 0, totalPages: 0 },
    });
    vi.spyOn(ConstituentService, "listConstituents").mockResolvedValue({
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          orgId: "org-1",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          phone: null,
          type: "donor",
          tags: null,
          deletedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      pagination: { page: 1, perPage: 50, total: 1, totalPages: 1 },
    });
    const createDonation = vi.spyOn(DonationService, "createDonation").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      orgId: "org-1",
      constituentId: "22222222-2222-4222-8222-222222222222",
      amountCents: 2550,
      currency: "EUR",
      campaignId: null,
      paymentMethod: null,
      paymentRef: null,
      donatedAt: "2026-04-22T00:00:00.000Z",
      fiscalYear: 2026,
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    });

    render(<DonationForm mode="create" />);

    await waitFor(() => expect(CampaignService.listCampaigns).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Search for a donor…" }));
    await waitFor(() => expect(ConstituentService.listConstituents).toHaveBeenCalled());
    await user.click(await screen.findByText("Ada Lovelace"));

    const amountInput = screen.getByPlaceholderText("0.00");
    await user.type(amountInput, "25,50");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Save donation" }));

    await waitFor(() => expect(createDonation).toHaveBeenCalled());
    expect(createDonation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        constituentId: "22222222-2222-4222-8222-222222222222",
        amountCents: 2550,
        currency: "EUR",
      }),
    );
    expect(mockToast.success).toHaveBeenCalledWith("Donation recorded.");
    expect(mockRouter.push).toHaveBeenCalledWith("/donations/33333333-3333-4333-8333-333333333333");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("updates an existing donation", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignService, "listCampaigns").mockResolvedValue({
      data: [],
      pagination: { page: 1, perPage: 100, total: 0, totalPages: 0 },
    });
    const updateDonation = vi.spyOn(DonationService, "updateDonation").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      orgId: "org-1",
      constituentId: "22222222-2222-4222-8222-222222222222",
      amountCents: 3000,
      currency: "EUR",
      campaignId: null,
      paymentMethod: "wire",
      paymentRef: "WIRE-2026-0001",
      donatedAt: "2026-04-22T00:00:00.000Z",
      fiscalYear: 2026,
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z",
    });

    render(
      <DonationForm
        mode="edit"
        donation={{
          id: "33333333-3333-4333-8333-333333333333",
          orgId: "org-1",
          constituentId: "22222222-2222-4222-8222-222222222222",
          amountCents: 2550,
          currency: "EUR",
          campaignId: null,
          paymentMethod: "wire",
          paymentRef: "WIRE-2026-0001",
          donatedAt: "2026-04-22T00:00:00.000Z",
          fiscalYear: 2026,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
          constituent: {
            id: "22222222-2222-4222-8222-222222222222",
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
          },
          allocations: [],
        }}
      />,
    );

    await waitFor(() => expect(CampaignService.listCampaigns).toHaveBeenCalled());

    const amountInput = screen.getByDisplayValue("25.50");
    await user.clear(amountInput);
    await user.type(amountInput, "30,00");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateDonation).toHaveBeenCalled());
    expect(updateDonation).toHaveBeenCalledWith(
      expect.anything(),
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        constituentId: "22222222-2222-4222-8222-222222222222",
        amountCents: 3000,
        paymentMethod: "wire",
      }),
    );
    expect(mockToast.success).toHaveBeenCalledWith("Donation updated.");
    expect(mockRouter.push).toHaveBeenCalledWith("/donations/33333333-3333-4333-8333-333333333333");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });
});
