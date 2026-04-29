"use client";

import { loadStripe } from "@stripe/stripe-js";

/**
 * Outcome of inspecting the URL after a Stripe redirect (typically a
 * 3DS / SCA challenge that bounced the donor back to `return_url`).
 *
 * `null` = no redirect in progress, render the normal donor flow.
 *
 * Issue #197: without this handler, a donor whose card requires 3DS
 * sees the page reset to an empty donation form after the bank challenge
 * — they'd believe the payment failed, churn, or retry and create a
 * duplicate intent. EU PSD2 mandates SCA on a non-trivial share of cards
 * so this matters at scale.
 */
export type PostRedirectOutcome =
  | {
      kind: "succeeded";
      amountCents: number;
      currency: string;
    }
  | {
      kind: "requires_action";
      // Re-mounting the Payment Element against the same intent lets the
      // donor pick a different card or retry without creating a new
      // PaymentIntent (which would duplicate metadata + leak an extra
      // application_fee on the connected account if they retry-succeed).
      clientSecret: string;
      amountCents: number;
      currency: string;
    }
  | {
      kind: "processing";
    }
  | {
      kind: "failed";
      // Donor-facing message lifted from `last_payment_error.message` —
      // already localised by Stripe.js per the donor's locale.
      message: string;
    };

interface RetrieveOptions {
  publishableKey: string;
  stripeAccountId: string;
  /**
   * In production read from `window.location.search`. Tests pass a string
   * so we can drive the function deterministically without monkey-patching
   * the global location.
   */
  search?: string;
  /**
   * Whether to strip the redirect query params from the URL bar after
   * resolving — defaults to true so a refresh doesn't loop into the
   * same retrieve. Tests pass `false` so the assertion can inspect the
   * input that was parsed.
   */
  cleanUrl?: boolean;
}

/**
 * Inspect the URL for Stripe's post-redirect query params and resolve
 * them via `stripe.retrievePaymentIntent`. Returns `null` if the page
 * was not loaded as a redirect target.
 *
 * Connect direct-charge note: the Stripe.js client must bind to the
 * connected account (`stripeAccount`) — same constraint as the inline
 * `confirmPayment` flow. Without it the retrieve 404s the intent.
 */
export async function retrievePostRedirectIntent(
  options: RetrieveOptions,
): Promise<PostRedirectOutcome | null> {
  if (typeof window === "undefined") return null;

  const search = options.search ?? window.location.search;
  const params = new URLSearchParams(search);
  const clientSecret = params.get("payment_intent_client_secret");
  // `payment_intent` arrives alongside but we don't need it — clientSecret
  // already binds to the specific intent on the connected account.
  if (!clientSecret) return null;

  const stripe = await loadStripe(options.publishableKey, {
    stripeAccount: options.stripeAccountId,
  });
  if (!stripe) {
    return { kind: "failed", message: "Stripe.js failed to load" };
  }

  const { paymentIntent, error } = await stripe.retrievePaymentIntent(clientSecret);

  if (options.cleanUrl !== false) {
    // Drop the redirect params so a refresh doesn't loop the retrieval.
    // Use replaceState so we don't add a history entry.
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("payment_intent");
    cleanUrl.searchParams.delete("payment_intent_client_secret");
    cleanUrl.searchParams.delete("redirect_status");
    window.history.replaceState({}, "", cleanUrl.toString());
  }

  if (error) {
    return { kind: "failed", message: error.message ?? "Payment could not be confirmed." };
  }
  if (!paymentIntent) {
    return { kind: "failed", message: "Payment could not be confirmed." };
  }

  switch (paymentIntent.status) {
    case "succeeded":
      return {
        kind: "succeeded",
        amountCents: paymentIntent.amount,
        currency: (paymentIntent.currency ?? "eur").toUpperCase(),
      };
    case "processing":
      return { kind: "processing" };
    case "requires_payment_method":
    case "requires_action":
      return {
        kind: "requires_action",
        clientSecret,
        amountCents: paymentIntent.amount,
        currency: (paymentIntent.currency ?? "eur").toUpperCase(),
      };
    default:
      return {
        kind: "failed",
        message: paymentIntent.last_payment_error?.message ?? "Payment did not complete.",
      };
  }
}
