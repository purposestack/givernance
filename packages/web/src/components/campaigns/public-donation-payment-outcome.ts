import type { PaymentIntent } from "@stripe/stripe-js";

/**
 * What the donor should be told for a given PaymentIntent status. Shared
 * by the inline `confirmPayment` path (`public-donation-payment-step.tsx`)
 * and the post-redirect path (`public-donation-post-redirect.ts`) so the
 * two can never disagree on whether a payment was accepted.
 *
 * Issue #615: the PaymentIntent uses automatic payment methods, so
 * delayed-notification methods (SEPA Debit, Bacs) resolve to `processing`
 * — the debit IS accepted, the funds just settle later. Showing that as
 * an error invites a retry and a double debit. The rule this mapping
 * encodes: **never invite a retry once the payment method was accepted.**
 *
 * - `succeeded`       funds captured → thank-you panel
 * - `processing`      accepted, settling asynchronously → "being processed"
 *                     panel (`requires_capture` lands here too: the funds
 *                     are already held, a retry would hold them twice)
 * - `requires_action` the donor still owes a step Stripe drives
 * - `retryable`       the method was refused, the SAME intent can take
 *                     another one (no duplicate PaymentIntent)
 * - `failed`          terminal (canceled / unknown) → error
 */
export type PaymentOutcomeKind =
  | "succeeded"
  | "processing"
  | "requires_action"
  | "retryable"
  | "failed";

export function resolvePaymentOutcome(status: PaymentIntent.Status): PaymentOutcomeKind {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "processing":
    case "requires_capture":
      return "processing";
    case "requires_action":
      return "requires_action";
    case "requires_payment_method":
      return "retryable";
    default:
      return "failed";
  }
}
