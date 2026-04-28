"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe, type StripeElementsOptions } from "@stripe/stripe-js";
import { CheckCircle2, FlaskConical, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

interface PublicDonationPaymentStepProps {
  clientSecret: string;
  stripeAccountId: string;
  publishableKey: string;
  colorPrimary: string;
  amountSummary: string;
  onPaid: () => void;
}

/**
 * Stripe publishable keys are `pk_test_…` in test mode and `pk_live_…` in
 * production. Detecting the prefix is sufficient for gating the test-card
 * hint banner — checking server `NODE_ENV` would be wrong since a staging
 * web build can run against test-mode Stripe.
 */
function isTestModeKey(publishableKey: string): boolean {
  return publishableKey.startsWith("pk_test_");
}

/**
 * Mounts Stripe Elements against the given clientSecret + connected account
 * and renders the Payment Element. Memoised by `(publishableKey,
 * stripeAccountId)` so we don't reload Stripe.js on every parent re-render.
 *
 * Direct-charge note: the PaymentIntent lives on the connected account
 * (`stripeAccount` request option in the API), so the browser-side SDK must
 * also bind to that account via the `loadStripe` second arg — otherwise
 * `confirmPayment` 404s the intent.
 */
export function PublicDonationPaymentStep(props: PublicDonationPaymentStepProps) {
  const stripePromise = useMemo<Promise<Stripe | null>>(
    () => loadStripe(props.publishableKey, { stripeAccount: props.stripeAccountId }),
    [props.publishableKey, props.stripeAccountId],
  );

  const elementsOptions: StripeElementsOptions = useMemo(
    () => ({
      clientSecret: props.clientSecret,
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: props.colorPrimary,
          fontFamily: "var(--font-body), system-ui, sans-serif",
          borderRadius: "12px",
        },
      },
      // Keep Stripe's UI in the donor's locale; falls back to English.
      locale: "auto",
    }),
    [props.clientSecret, props.colorPrimary],
  );

  return (
    <Elements stripe={stripePromise} options={elementsOptions}>
      <PaymentForm
        amountSummary={props.amountSummary}
        colorPrimary={props.colorPrimary}
        testMode={isTestModeKey(props.publishableKey)}
        onPaid={props.onPaid}
      />
    </Elements>
  );
}

function PaymentForm({
  amountSummary,
  colorPrimary,
  testMode,
  onPaid,
}: {
  amountSummary: string;
  colorPrimary: string;
  testMode: boolean;
  onPaid: () => void;
}) {
  const t = useTranslations("publicDonationPage.payment");
  const stripe = useStripe();
  const elements = useElements();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    // `redirect: 'if_required'` keeps card payments in-page and only redirects
    // when the donor's payment method genuinely needs it (3DS, wallets) —
    // we still send a `return_url` because Stripe requires one for those
    // fallback redirects.
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });

    if (result.error) {
      // Stripe's docs recommend showing `error.message` directly — they're
      // donor-facing strings already (localised by Stripe.js).
      setError(result.error.message ?? t("errors.generic"));
      setSubmitting(false);
      return;
    }

    if (result.paymentIntent?.status === "succeeded") {
      setPaid(true);
      onPaid();
    } else {
      setError(t("errors.generic"));
    }
    setSubmitting(false);
  }

  if (paid) {
    return (
      <div
        role="status"
        className="flex flex-col items-start gap-3 rounded-2xl border border-outline-variant bg-surface px-4 py-5 text-sm text-on-surface"
      >
        <span
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ backgroundColor: `color-mix(in srgb, ${colorPrimary} 18%, white)` }}
        >
          <CheckCircle2 size={20} style={{ color: colorPrimary }} aria-hidden="true" />
        </span>
        <p className="font-medium text-on-surface">{t("success.title")}</p>
        <p className="text-on-surface-variant">{t("success.body", { amount: amountSummary })}</p>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <div className="rounded-2xl border border-outline-variant bg-surface px-4 py-3 text-sm text-on-surface-variant">
        <p className="text-on-surface">{t("summary.title", { amount: amountSummary })}</p>
        <p className="mt-1 text-xs">{t("summary.subtitle")}</p>
      </div>

      {testMode ? (
        <div
          role="note"
          className="flex items-start gap-3 rounded-2xl border border-tertiary bg-tertiary-container px-4 py-3 text-sm text-on-tertiary-container"
        >
          <FlaskConical size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">{t("testMode.title")}</p>
            <p className="text-xs leading-5">
              {t("testMode.bodyBefore")}{" "}
              <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-on-surface">
                4242 4242 4242 4242
              </code>{" "}
              {t("testMode.bodyAfter")}
            </p>
          </div>
        </div>
      ) : null}

      <PaymentElement options={{ layout: "tabs" }} />

      {error ? <p className="text-sm text-error">{error}</p> : null}

      <Button
        type="submit"
        className="w-full"
        disabled={submitting || !stripe || !elements}
        style={{ backgroundColor: colorPrimary, color: getReadableTextColor(colorPrimary) }}
      >
        {submitting ? (
          <>
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            {t("actions.paying")}
          </>
        ) : (
          t("actions.pay", { amount: amountSummary })
        )}
      </Button>
    </form>
  );
}

function getReadableTextColor(hex: string): "#FFFFFF" | "#111827" {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#FFFFFF";
}
