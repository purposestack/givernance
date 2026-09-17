import { resolvePaymentOutcome } from "./public-donation-payment-outcome";

describe("resolvePaymentOutcome", () => {
  it("maps succeeded to the thank-you outcome", () => {
    expect(resolvePaymentOutcome("succeeded")).toBe("succeeded");
  });

  it("maps processing (SEPA Debit / Bacs accepted, settling later) to processing — never an error", () => {
    expect(resolvePaymentOutcome("processing")).toBe("processing");
  });

  it("treats requires_capture as accepted so the donor is not invited to retry held funds", () => {
    expect(resolvePaymentOutcome("requires_capture")).toBe("processing");
  });

  it("maps requires_action to the pending-step outcome", () => {
    expect(resolvePaymentOutcome("requires_action")).toBe("requires_action");
  });

  it("maps requires_payment_method to a retry on the same intent", () => {
    expect(resolvePaymentOutcome("requires_payment_method")).toBe("retryable");
  });

  it("maps canceled and other terminal statuses to failed", () => {
    expect(resolvePaymentOutcome("canceled")).toBe("failed");
    expect(resolvePaymentOutcome("requires_confirmation")).toBe("failed");
  });
});
