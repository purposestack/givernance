import { PublicDonationPaymentStep } from "@/components/campaigns/public-donation-payment-step";
import { render, screen, userEvent } from "../../tests/test-utils";

// Issue #615 — the inline `confirmPayment` result. The Payment Element
// itself is an iframe we can't drive from jsdom, so Stripe.js is stubbed and
// each test scripts what `confirmPayment` resolves to.
const { mockConfirmPayment } = vi.hoisted(() => ({ mockConfirmPayment: vi.fn() }));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn().mockResolvedValue({}),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="stripe-payment-element" />,
  useStripe: () => ({ confirmPayment: mockConfirmPayment }),
  useElements: () => ({}),
}));

function renderStep(onPaid = vi.fn()) {
  render(
    <PublicDonationPaymentStep
      clientSecret="pi_secret_123"
      stripeAccountId="acct_test_123"
      publishableKey="pk_live_dummy"
      colorPrimary="#08675b"
      amountSummary="€50.00"
      onPaid={onPaid}
      onBack={vi.fn()}
    />,
  );
  return { onPaid };
}

const PROCESSING_COPY =
  "Your payment is being processed. You'll receive a confirmation email shortly.";
const GENERIC_ERROR =
  "Payment could not be completed. Please try a different card or contact support.";

describe("PublicDonationPaymentStep — confirmPayment outcomes", () => {
  beforeEach(() => {
    mockConfirmPayment.mockReset();
  });

  it("shows the thank-you panel and fires onPaid when the intent succeeded", async () => {
    const user = userEvent.setup();
    mockConfirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    const { onPaid } = renderStep();

    await user.click(screen.getByRole("button", { name: "Donate €50.00" }));

    expect(await screen.findByText("Thank you for your donation!")).toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("treats a `processing` debit (SEPA / Bacs) as accepted — no error, no way to pay twice", async () => {
    const user = userEvent.setup();
    mockConfirmPayment.mockResolvedValue({ paymentIntent: { status: "processing" } });
    renderStep();

    await user.click(screen.getByRole("button", { name: "Donate €50.00" }));

    expect(await screen.findByText(PROCESSING_COPY)).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_ERROR)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The pay button and the Payment Element are gone: the donor cannot
    // submit the accepted debit a second time.
    expect(screen.queryByRole("button", { name: "Donate €50.00" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("stripe-payment-element")).not.toBeInTheDocument();
  });

  it("withdraws the form with pending copy when the intent still requires an out-of-page action", async () => {
    const user = userEvent.setup();
    mockConfirmPayment.mockResolvedValue({ paymentIntent: { status: "requires_action" } });
    renderStep();

    await user.click(screen.getByRole("button", { name: "Donate €50.00" }));

    expect(await screen.findByText(/Your payment needs one more step/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Donate €50.00" })).not.toBeInTheDocument();
  });

  it("keeps the form open with an announced error when the intent was canceled", async () => {
    const user = userEvent.setup();
    mockConfirmPayment.mockResolvedValue({ paymentIntent: { status: "canceled" } });
    renderStep();

    await user.click(screen.getByRole("button", { name: "Donate €50.00" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    expect(screen.getByRole("button", { name: "Donate €50.00" })).toBeEnabled();
  });

  it("announces Stripe's own localised message when confirmPayment returns an error", async () => {
    const user = userEvent.setup();
    mockConfirmPayment.mockResolvedValue({ error: { message: "Your card was declined." } });
    const { onPaid } = renderStep();

    await user.click(screen.getByRole("button", { name: "Donate €50.00" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(onPaid).not.toHaveBeenCalled();
  });
});
