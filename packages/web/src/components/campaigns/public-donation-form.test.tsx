import { PublicDonationForm } from "@/components/campaigns/public-donation-form";
import { ApiProblem } from "@/lib/api";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { mockToast, render, screen, userEvent, waitFor } from "../../tests/test-utils";

describe("PublicDonationForm", () => {
  it("shows inline validation errors before submission", async () => {
    const user = userEvent.setup();

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={50000}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    expect(await screen.findByText("Enter your first name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your last name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter a donation amount.")).toBeInTheDocument();
  });

  it("creates a donation intent with trimmed values and cents", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockResolvedValue({
      clientSecret: "pi_secret_123",
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={50000}
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "  Jane ");
    await user.type(screen.getByLabelText(/^Last name/), " Doe  ");
    await user.type(screen.getByLabelText(/^Email/), " jane@example.org ");
    await user.click(screen.getByRole("button", { name: "€100" }));
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    await waitFor(() =>
      expect(CampaignPublicPageService.createPublicDonationIntent).toHaveBeenCalledWith(
        expect.anything(),
        "11111111-1111-4111-8111-111111111111",
        {
          amountCents: 10000,
          currency: "EUR",
          email: "jane@example.org",
          firstName: "Jane",
          lastName: "Doe",
        },
        expect.any(String),
      ),
    );

    expect(mockToast.success).toHaveBeenCalledWith(
      "Your donation is ready. The Stripe payment step is the next integration.",
    );
    expect(await screen.findByText("Next step")).toBeInTheDocument();
  });

  it("shows an API error toast when payment preparation fails", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockRejectedValue(
      new ApiProblem({
        type: "https://givernance.test/problems/payment",
        title: "Payment failure",
        status: 500,
        detail: "Stripe is unavailable.",
      }),
    );

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "Jane");
    await user.type(screen.getByLabelText(/^Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Email/), "jane@example.org");
    await user.type(screen.getByLabelText(/^Amount/), "50");
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Stripe is unavailable."));
  });
});
