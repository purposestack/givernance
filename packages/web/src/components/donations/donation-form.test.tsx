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

    render(<DonationForm />);

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
});
