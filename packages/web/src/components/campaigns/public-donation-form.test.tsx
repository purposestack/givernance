import { PublicDonationForm } from "@/components/campaigns/public-donation-form";
import { ApiProblem } from "@/lib/api";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { mockToast, render, screen, userEvent, waitFor } from "../../tests/test-utils";

// Stub Stripe.js so the Payment Element step renders without trying to load
// the real script in jsdom. We don't assert anything inside the iframe — the
// integration test for confirmPayment lives in Stripe's own test mode.
const { mockRetrievePaymentIntent } = vi.hoisted(() => ({
  mockRetrievePaymentIntent: vi.fn(),
}));
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn().mockResolvedValue({
    retrievePaymentIntent: mockRetrievePaymentIntent,
  }),
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
        tenantStripeAccountId={null}
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
        tenantStripeAccountId="acct_test_999"
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
        tenantStripeAccountId="acct_test_999"
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
        tenantStripeAccountId="acct_test_999"
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
        tenantStripeAccountId="acct_live_888"
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
        tenantStripeAccountId={null}
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
        tenantStripeAccountId={null}
      />,
    );

    await user.type(screen.getByLabelText(/^First name/), "Jane");
    await user.type(screen.getByLabelText(/^Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Email/), "jane@example.org");
    await user.type(screen.getByLabelText(/^Amount/), "50");
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Stripe is unavailable."));
  });

  // ─── Issue #197: Post-3DS return handler ────────────────────────────────

  it("renders the post-3DS success state when ?payment_intent_client_secret is present and the intent succeeded", async () => {
    // Stripe's redirect-back URL on a 3DS success.
    const originalSearch = window.location.search;
    window.history.replaceState(
      {},
      "",
      "?payment_intent=pi_post3ds&payment_intent_client_secret=pi_post3ds_secret&redirect_status=succeeded",
    );
    mockRetrievePaymentIntent.mockResolvedValueOnce({
      paymentIntent: {
        id: "pi_post3ds",
        amount: 5000,
        currency: "eur",
        status: "succeeded",
      },
      error: null,
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
        publishableKey="pk_test_dummy"
        tenantStripeAccountId="acct_test_999"
      />,
    );

    expect(await screen.findByText("Thank you for your donation!")).toBeInTheDocument();
    // Donor-details form must NOT be shown — we'd be asking them to
    // re-enter info they already submitted before the 3DS challenge.
    expect(screen.queryByLabelText(/^First name/)).not.toBeInTheDocument();
    // URL should be cleaned of redirect params so a refresh doesn't loop
    // the retrieve call.
    await waitFor(() =>
      expect(window.location.search).not.toContain("payment_intent_client_secret"),
    );

    // Restore for downstream tests.
    window.history.replaceState({}, "", originalSearch || "/");
  });

  it("renders a retry CTA when post-3DS status is requires_payment_method", async () => {
    const originalSearch = window.location.search;
    window.history.replaceState(
      {},
      "",
      "?payment_intent=pi_post3ds_fail&payment_intent_client_secret=pi_post3ds_fail_secret&redirect_status=failed",
    );
    mockRetrievePaymentIntent.mockResolvedValueOnce({
      paymentIntent: {
        id: "pi_post3ds_fail",
        amount: 5000,
        currency: "eur",
        status: "requires_payment_method",
        last_payment_error: { message: "Your card was declined." },
      },
      error: null,
    });

    render(
      <PublicDonationForm
        campaignId="11111111-1111-4111-8111-111111111111"
        colorPrimary="#096447"
        locale="en"
        goalAmountCents={null}
        publishableKey="pk_test_dummy"
        tenantStripeAccountId="acct_test_999"
      />,
    );

    // Retry CTA + Payment Element re-mounted on the SAME intent's
    // clientSecret so the donor doesn't create a duplicate PaymentIntent.
    expect(
      await screen.findByText(/Your payment didn't complete\. Try a different card/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("stripe-payment-element")).toBeInTheDocument();

    window.history.replaceState({}, "", originalSearch || "/");
  });
});
