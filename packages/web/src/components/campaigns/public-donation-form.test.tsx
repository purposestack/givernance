import { PublicDonationForm } from "@/components/campaigns/public-donation-form";
import { ApiProblem } from "@/lib/api";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { mockToast, render, screen, userEvent, waitFor } from "../../tests/test-utils";

// Stub Stripe.js so the Payment Element step renders without trying to load
// the real script in jsdom. We don't assert anything inside the iframe — the
// integration test for confirmPayment lives in Stripe's own test mode.
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn().mockResolvedValue(null),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
  PaymentElement: () => <div data-testid="stripe-payment-element" />,
  useStripe: () => null,
  useElements: () => null,
}));

describe("PublicDonationForm", () => {
  it("shows inline validation errors before submission", async () => {
    const user = userEvent.setup();

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={50000}
        publishableKey={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    expect(await screen.findByText("Enter your first name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your last name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter a donation amount.")).toBeInTheDocument();
  });

  it("creates a donation intent and transitions to the Payment Element step", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockResolvedValue({
      clientSecret: "pi_secret_123",
      stripeAccountId: "acct_test_123",
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={50000}
        publishableKey="pk_test_dummy"
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
      "Donation prepared — enter your card details below.",
    );
    // Transition: details form is gone, Stripe Elements mounted.
    expect(await screen.findByTestId("stripe-payment-element")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^First name/)).not.toBeInTheDocument();
  });

  it("returns to the donor-details form with values preserved when 'Edit my donation' is clicked", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockResolvedValue({
      clientSecret: "pi_secret_456",
      stripeAccountId: "acct_test_123",
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
        publishableKey="pk_test_dummy"
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "Jane");
    await user.type(screen.getByLabelText(/^Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Email/), "jane@example.org");
    await user.type(screen.getByLabelText(/^Amount/), "75");
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    // Wait for the Payment Element to mount, confirming we transitioned.
    expect(await screen.findByTestId("stripe-payment-element")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit my donation" }));

    // Donor-details fields are back, AND the values they typed are still there
    // (parent state preserves `values` across the session-clear).
    expect(await screen.findByLabelText(/^First name/)).toHaveValue("Jane");
    expect(screen.getByLabelText(/^Last name/)).toHaveValue("Doe");
    expect(screen.getByLabelText(/^Email/)).toHaveValue("jane@example.org");
    expect(screen.getByLabelText(/^Amount/)).toHaveValue(75);
    expect(screen.queryByTestId("stripe-payment-element")).not.toBeInTheDocument();
  });

  it("renders the test-mode banner when publishableKey starts with pk_test_", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockResolvedValue({
      clientSecret: "pi_secret_999",
      stripeAccountId: "acct_test_999",
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
        publishableKey="pk_test_dummy"
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "Jane");
    await user.type(screen.getByLabelText(/^Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Email/), "jane@example.org");
    await user.type(screen.getByLabelText(/^Amount/), "50");
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    expect(await screen.findByText("Test mode — no real charge")).toBeInTheDocument();
    expect(screen.getByText("4242 4242 4242 4242")).toBeInTheDocument();
  });

  it("does NOT render the test-mode banner when publishableKey starts with pk_live_", async () => {
    // Critical inverse: a flipped predicate would silently leak "Test mode"
    // copy onto live-donor pages. We assert both the banner heading and the
    // card hint are absent.
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockResolvedValue({
      clientSecret: "pi_secret_888",
      stripeAccountId: "acct_live_888",
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
        publishableKey="pk_live_real_key"
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "Jane");
    await user.type(screen.getByLabelText(/^Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Email/), "jane@example.org");
    await user.type(screen.getByLabelText(/^Amount/), "50");
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    expect(await screen.findByTestId("stripe-payment-element")).toBeInTheDocument();
    expect(screen.queryByText("Test mode — no real charge")).not.toBeInTheDocument();
    expect(screen.queryByText("4242 4242 4242 4242")).not.toBeInTheDocument();
  });

  it("blocks at payment step with a clear message when publishableKey is not configured", async () => {
    const user = userEvent.setup();

    vi.spyOn(CampaignPublicPageService, "createPublicDonationIntent").mockResolvedValue({
      clientSecret: "pi_secret_123",
      stripeAccountId: "acct_test_123",
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
        publishableKey={null}
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "Jane");
    await user.type(screen.getByLabelText(/^Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Email/), "jane@example.org");
    await user.type(screen.getByLabelText(/^Amount/), "50");
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    expect(await screen.findByText(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/i)).toBeInTheDocument();
    expect(screen.queryByTestId("stripe-payment-element")).not.toBeInTheDocument();
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
        publishableKey={null}
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
