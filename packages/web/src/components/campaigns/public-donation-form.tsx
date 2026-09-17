"use client";

import { CheckCircle2, HeartHandshake, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import {
  PUBLIC_DONATION_MAX_CENTS,
  PUBLIC_DONATION_MIN_CENTS,
  parseDonationAmount,
} from "@/components/campaigns/public-donation-amount";
import {
  PaymentProcessingNotice,
  PublicDonationPaymentStep,
} from "@/components/campaigns/public-donation-payment-step";
import {
  type PostRedirectOutcome,
  retrievePostRedirectIntent,
} from "@/components/campaigns/public-donation-post-redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { getReadableTextColor } from "@/lib/color";
import { formatCurrency } from "@/lib/format";
import type { PublicDonationCurrency } from "@/models/public-page";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";

interface PublicDonationFormProps {
  campaignId: string;
  colorPrimary: string;
  locale: string;
  goalAmountCents: number | null;
  defaultCurrency?: PublicDonationCurrency;
  /**
   * Stripe platform publishable key (`pk_test_...` / `pk_live_...`). Threaded
   * from the server component so we don't have to re-evaluate
   * `process.env.NEXT_PUBLIC_*` at every keystroke. `null` when the env var
   * is not set — the form still collects donor info but blocks at the
   * payment step with a clear message.
   */
  publishableKey: string | null;
  /**
   * Tenant's connected account id (`acct_…`). Available before the donor
   * has submitted, so we can detect a 3DS post-redirect on mount and
   * resolve the PaymentIntent without round-tripping to the donate
   * endpoint first (issue #197). Null when the tenant hasn't onboarded
   * yet — donor flow degrades gracefully (no post-redirect retrieval, the
   * donate step itself blocks at 502).
   */
  tenantStripeAccountId: string | null;
  /**
   * Opaque QR token resolved from `?qr=` on the public page URL (Epic
   * #274). When present the donate intent forwards it to the API so the
   * resulting donation gets reconciled to the printed letter's campaign
   * and constituent. Undefined for organic visits to the donation page.
   */
  qrCode?: string;
  /**
   * Drop the form's own white-card chrome (background, border, shadow,
   * outer padding). Set to `true` when the form is rendered INSIDE an
   * Epic-#362 archetype slot — each archetype's AmountPicker already
   * provides its own card (warm-paper for Activist, soft pastel for
   * Calm, glass-blur for Cosmic), so the default Givernance chrome
   * would stack a second card on top and visibly clash with the
   * archetype's voice. The form's inner content (eyebrow, title,
   * description, fields, CTA) still renders.
   */
  chromeless?: boolean;
}

interface PublicDonationFormValues {
  firstName: string;
  lastName: string;
  email: string;
  amount: string;
  currency: PublicDonationCurrency;
}

interface FormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  amount?: string;
}

interface PaymentSession {
  clientSecret: string;
  stripeAccountId: string;
  amountCents: number;
  currency: PublicDonationCurrency;
}

/**
 * Outcome resolved from `?payment_intent_client_secret=…` query params on
 * mount — i.e., the donor was redirected here after a 3DS challenge. See
 * `public-donation-post-redirect.ts` for the full type and rationale.
 */
type PostRedirectState = { kind: "checking" } | PostRedirectOutcome | null;

/**
 * DOM ids of the validated inputs, in visual order — `handleSubmit` moves
 * focus to the first one that failed validation (WCAG 3.3.1), and `Field`
 * derives the `aria-describedby` error id from the same value.
 */
const FIELD_INPUT_IDS = {
  firstName: "public-donation-first-name",
  lastName: "public-donation-last-name",
  email: "public-donation-email",
  amount: "public-donation-amount",
} as const satisfies Record<keyof FormErrors, string>;

function fieldErrorId(inputId: string): string {
  return `${inputId}-error`;
}

const SUGGESTED_AMOUNTS = [25, 50, 100] as const;

const DEFAULT_VALUES: PublicDonationFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  amount: "",
  currency: "EUR",
};
const PUBLIC_DONATION_CURRENCIES: PublicDonationCurrency[] = ["EUR", "GBP", "CHF"];

export function PublicDonationForm({
  campaignId,
  colorPrimary,
  locale,
  goalAmountCents,
  defaultCurrency = "EUR",
  publishableKey,
  tenantStripeAccountId,
  qrCode,
  chromeless = false,
}: PublicDonationFormProps) {
  const t = useTranslations("publicDonationPage.form");
  const tPayment = useTranslations("publicDonationPage.payment");
  const [values, setValues] = useState<PublicDonationFormValues>({
    ...DEFAULT_VALUES,
    currency: defaultCurrency,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [session, setSession] = useState<PaymentSession | null>(null);
  // Detect 3DS post-redirect on mount. `checking` keeps the donor from
  // briefly seeing the empty form before retrieve resolves; `null` means
  // there's nothing to retrieve (most visits) and the form renders normally.
  const initialPostRedirect: PostRedirectState =
    typeof window !== "undefined" &&
    publishableKey &&
    tenantStripeAccountId &&
    new URLSearchParams(window.location.search).has("payment_intent_client_secret")
      ? { kind: "checking" }
      : null;
  const [postRedirect, setPostRedirect] = useState<PostRedirectState>(initialPostRedirect);

  useEffect(() => {
    if (!postRedirect || postRedirect.kind !== "checking") return;
    if (!publishableKey || !tenantStripeAccountId) return;

    let active = true;
    void retrievePostRedirectIntent({ publishableKey, stripeAccountId: tenantStripeAccountId })
      .then((outcome) => {
        if (!active) return;
        if (!outcome) {
          setPostRedirect(null);
          return;
        }
        setPostRedirect(outcome);
      })
      .catch(() => {
        if (!active) return;
        setPostRedirect({ kind: "failed", reason: "notConfirmed" });
      });

    return () => {
      active = false;
    };
  }, [postRedirect, publishableKey, tenantStripeAccountId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Limits are shown in the page locale + the currency the donor picked.
    const nextErrors = validate(values, t, {
      belowMin: t("errors.amountTooLow", {
        amount: formatCurrency(PUBLIC_DONATION_MIN_CENTS, locale, values.currency),
      }),
      aboveMax: t("errors.amountTooHigh", {
        amount: formatCurrency(PUBLIC_DONATION_MAX_CENTS, locale, values.currency),
      }),
    });
    setErrors(nextErrors);
    const firstInvalid = (Object.keys(FIELD_INPUT_IDS) as Array<keyof FormErrors>).find(
      (field) => nextErrors[field],
    );
    if (firstInvalid) {
      // Send keyboard / screen-reader donors straight to the field to fix;
      // its error text is announced through `aria-describedby`.
      document.getElementById(FIELD_INPUT_IDS[firstInvalid])?.focus();
      return;
    }

    const parsedAmount = parseDonationAmount(values.amount);
    if (!parsedAmount.ok) return;
    const amountCents = parsedAmount.cents;

    setIsSubmitting(true);

    try {
      const result = await CampaignPublicPageService.createPublicDonationIntent(
        createClientApiClient(),
        campaignId,
        {
          amountCents,
          currency: values.currency,
          email: values.email.trim(),
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
          // Postal-letter QR attribution (Epic #274) — only forwarded when
          // present so organic visits stay clean of meaningless qrCode keys.
          ...(qrCode ? { qrCode } : {}),
        },
        createIdempotencyKey(),
      );

      setSession({
        clientSecret: result.clientSecret,
        stripeAccountId: result.stripeAccountId,
        amountCents,
        currency: values.currency,
      });
      toast.success(t("success.intentCreated"));
    } catch (error) {
      toast.error(resolveIntentErrorMessage(error, t));
    } finally {
      setIsSubmitting(false);
    }
  }

  // When rendered inside an archetype slot, drop the white-card chrome
  // so the archetype's own AmountPicker wrapper (warm paper / glass /
  // pastel) is the only card the donor sees. The chrome variant sets
  // `text-on-surface` so descendant `text-current` classes inherit
  // dark ink on white; chromeless inherits the archetype wrapper's
  // explicit colour (white for Cosmic, dark ink for Activist/Calm)
  // which is calibrated for that archetype's surface — same WCAG AA
  // contract in both modes without per-element branching. Inputs keep
  // their own bg + dark text; those are self-contained surfaces.
  const shellClassName = chromeless
    ? "text-current"
    : "rounded-[28px] border border-outline-variant bg-surface-container-lowest p-6 text-on-surface shadow-card sm:p-7";

  return (
    <section className={shellClassName}>
      <div className="flex items-center gap-3">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-2xl"
          style={{ backgroundColor: `color-mix(in srgb, ${colorPrimary} 16%, white)` }}
        >
          <HeartHandshake size={20} aria-hidden="true" style={{ color: colorPrimary }} />
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-current opacity-80">
            {t("eyebrow")}
          </p>
          <h2 className="font-heading text-2xl text-current">{t("title")}</h2>
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-current opacity-80">{t("description")}</p>

      {/*
        Render priority:
        1. Post-3DS return state (donor came back from a Stripe redirect; we
           override everything else so they never see a blank form they
           already filled out before the challenge).
        2. Active payment session (donor in the Payment Element step).
        3. Donor details form (initial state).
      */}
      {postRedirect ? (
        <PostRedirectView
          state={postRedirect}
          colorPrimary={colorPrimary}
          locale={locale}
          publishableKey={publishableKey}
          tenantStripeAccountId={tenantStripeAccountId}
          onDismiss={() => setPostRedirect(null)}
        />
      ) : session ? (
        publishableKey ? (
          <div className="mt-6">
            <PublicDonationPaymentStep
              clientSecret={session.clientSecret}
              stripeAccountId={session.stripeAccountId}
              publishableKey={publishableKey}
              colorPrimary={colorPrimary}
              amountSummary={formatCurrency(session.amountCents, locale, session.currency)}
              onPaid={() => {
                toast.success(tPayment("success.title"));
              }}
              // Clearing `session` re-renders the donor-details form below.
              // `values` is preserved in parent state so fields pre-fill —
              // donor only edits what they want to change.
              onBack={() => setSession(null)}
            />
          </div>
        ) : (
          <p className="mt-6 rounded-2xl border border-error bg-error-container px-4 py-3 text-sm text-on-error-container">
            {tPayment("errors.missingPublishableKey")}
          </p>
        )
      ) : (
        <DonorDetailsForm
          values={values}
          errors={errors}
          isSubmitting={isSubmitting}
          colorPrimary={colorPrimary}
          locale={locale}
          goalAmountCents={goalAmountCents}
          defaultCurrency={defaultCurrency}
          onValuesChange={setValues}
          onErrorsChange={setErrors}
          onSubmit={handleSubmit}
        />
      )}
    </section>
  );
}

function DonorDetailsForm({
  values,
  errors,
  isSubmitting,
  colorPrimary,
  locale,
  goalAmountCents,
  defaultCurrency,
  onValuesChange,
  onErrorsChange,
  onSubmit,
}: {
  values: PublicDonationFormValues;
  errors: FormErrors;
  isSubmitting: boolean;
  colorPrimary: string;
  locale: string;
  goalAmountCents: number | null;
  defaultCurrency: PublicDonationCurrency;
  onValuesChange: (next: (current: PublicDonationFormValues) => PublicDonationFormValues) => void;
  onErrorsChange: (next: (current: FormErrors) => FormErrors) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  // Re-bind locally so next-intl's typed lookups stay specialised — passing
  // a hoisted `t` as a prop loses the namespace generic and triggers
  // TS2589 (`Type instantiation is excessively deep`).
  const t = useTranslations("publicDonationPage.form");
  return (
    <>
      {/*
        Suggested-amount chips. `aria-pressed` carries the toggle semantics
        for AT users — donors can pick any chip OR type a custom amount in
        the field below, which is why these are individual toggles rather
        than a `<RadioGroup>`. The `Button` size="lg" + height override
        gives a visibly tappable target on mobile while inheriting the
        design-system focus ring and disabled handling.
       */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {SUGGESTED_AMOUNTS.map((amount) => {
          const isSelected = values.amount === String(amount);
          return (
            <Button
              key={amount}
              type="button"
              variant={isSelected ? "primary" : "secondary"}
              size="lg"
              aria-pressed={isSelected}
              className="h-auto py-4 text-lg font-semibold sm:py-5 sm:text-xl"
              style={
                isSelected
                  ? {
                      backgroundColor: colorPrimary,
                      color: getReadableTextColor(colorPrimary),
                    }
                  : undefined
              }
              onClick={() => {
                onValuesChange((current) => ({ ...current, amount: String(amount) }));
                onErrorsChange((current) => ({ ...current, amount: undefined }));
              }}
            >
              {new Intl.NumberFormat(locale, {
                style: "currency",
                currency: values.currency,
                maximumFractionDigits: 0,
              }).format(amount)}
            </Button>
          );
        })}
      </div>

      {goalAmountCents !== null ? (
        <p className="mt-4 text-sm text-current opacity-80">
          {t("goal", { amount: formatCurrency(goalAmountCents, locale, defaultCurrency) })}
        </p>
      ) : null}

      <form
        className="mt-6 space-y-4"
        onSubmit={onSubmit}
        noValidate
        aria-busy={isSubmitting || undefined}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            inputId={FIELD_INPUT_IDS.firstName}
            label={t("fields.firstName")}
            error={errors.firstName}
            required
            input={
              <Input
                id={FIELD_INPUT_IDS.firstName}
                value={values.firstName}
                onChange={(event) => {
                  onValuesChange((current) => ({ ...current, firstName: event.target.value }));
                  onErrorsChange((current) => ({ ...current, firstName: undefined }));
                }}
                placeholder={t("fields.firstNamePlaceholder")}
                aria-required="true"
                aria-invalid={Boolean(errors.firstName)}
                aria-describedby={
                  errors.firstName ? fieldErrorId(FIELD_INPUT_IDS.firstName) : undefined
                }
                autoComplete="given-name"
              />
            }
          />
          <Field
            inputId={FIELD_INPUT_IDS.lastName}
            label={t("fields.lastName")}
            error={errors.lastName}
            required
            input={
              <Input
                id={FIELD_INPUT_IDS.lastName}
                value={values.lastName}
                onChange={(event) => {
                  onValuesChange((current) => ({ ...current, lastName: event.target.value }));
                  onErrorsChange((current) => ({ ...current, lastName: undefined }));
                }}
                placeholder={t("fields.lastNamePlaceholder")}
                aria-required="true"
                aria-invalid={Boolean(errors.lastName)}
                aria-describedby={
                  errors.lastName ? fieldErrorId(FIELD_INPUT_IDS.lastName) : undefined
                }
                autoComplete="family-name"
              />
            }
          />
        </div>

        <Field
          inputId={FIELD_INPUT_IDS.email}
          label={t("fields.email")}
          error={errors.email}
          required
          input={
            <Input
              id={FIELD_INPUT_IDS.email}
              type="email"
              value={values.email}
              onChange={(event) => {
                onValuesChange((current) => ({ ...current, email: event.target.value }));
                onErrorsChange((current) => ({ ...current, email: undefined }));
              }}
              placeholder={t("fields.emailPlaceholder")}
              aria-required="true"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? fieldErrorId(FIELD_INPUT_IDS.email) : undefined}
              autoComplete="email"
            />
          }
        />

        <Field
          inputId={FIELD_INPUT_IDS.amount}
          label={t("fields.amount")}
          error={errors.amount}
          required
          input={
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-variant">
                {getCurrencySymbol(values.currency)}
              </span>
              {/* `type="text"` on purpose — see `public-donation-amount.ts`
                  (a number input changes the amount on wheel-scroll and
                  blanks its value on a decimal comma). */}
              <Input
                id={FIELD_INPUT_IDS.amount}
                type="text"
                value={values.amount}
                onChange={(event) => {
                  onValuesChange((current) => ({ ...current, amount: event.target.value }));
                  onErrorsChange((current) => ({ ...current, amount: undefined }));
                }}
                placeholder={t("fields.amountPlaceholder")}
                aria-required="true"
                aria-invalid={Boolean(errors.amount)}
                aria-describedby={errors.amount ? fieldErrorId(FIELD_INPUT_IDS.amount) : undefined}
                className="pl-7"
                inputMode="decimal"
                autoComplete="transaction-amount"
              />
            </div>
          }
        />

        <Field
          inputId="public-donation-currency"
          label={t("fields.currency")}
          input={
            <Select
              value={values.currency}
              onValueChange={(currency) =>
                onValuesChange((current) => ({
                  ...current,
                  currency: currency as PublicDonationCurrency,
                }))
              }
            >
              <SelectTrigger id="public-donation-currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PUBLIC_DONATION_CURRENCIES.map((currency) => (
                  <SelectItem key={currency} value={currency}>
                    {currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitting}
          style={{ backgroundColor: colorPrimary, color: getReadableTextColor(colorPrimary) }}
        >
          {isSubmitting ? (
            <>
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
              {t("actions.submitting")}
            </>
          ) : (
            t("actions.submit")
          )}
        </Button>

        <p className="text-center text-xs leading-5 text-current opacity-80 sm:text-left">
          {t("footnote")}
        </p>
      </form>
    </>
  );
}

function getCurrencySymbol(currency: PublicDonationCurrency): string {
  switch (currency) {
    case "GBP":
      return "£";
    case "CHF":
      return "CHF";
    default:
      return "€";
  }
}

function Field({
  inputId,
  label,
  error,
  required,
  input,
}: {
  inputId?: string;
  label: string;
  error?: string;
  required?: boolean;
  input: ReactNode;
}) {
  // Label colour inherits via `text-current` from the outer
  // PublicDonationForm `<section>` — that section sets `text-on-surface`
  // in chrome mode and inherits the archetype's foreground in
  // chromeless mode, so the label stays readable in both contexts
  // without per-call branching here.
  return (
    <div className="block space-y-2">
      <label htmlFor={inputId} className="text-sm font-medium text-current">
        {label}
        {required ? <span className="ml-1 text-error">*</span> : null}
      </label>
      {input}
      {error ? (
        // The id is what the input's `aria-describedby` points at, so the
        // message is read with the field instead of floating beside it.
        <span id={inputId ? fieldErrorId(inputId) : undefined} className="block text-sm text-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function validate(
  values: PublicDonationFormValues,
  t: ReturnType<typeof useTranslations>,
  // Pre-resolved by the caller: interpolating `{amount}` through the
  // un-namespaced `t` above trips TS2589 (excessively deep instantiation).
  amountLimitMessages: { belowMin: string; aboveMax: string },
): FormErrors {
  const errors: FormErrors = {};

  if (!values.firstName.trim()) errors.firstName = t("errors.firstNameRequired");
  if (!values.lastName.trim()) errors.lastName = t("errors.lastNameRequired");

  const email = values.email.trim();
  if (!email) {
    errors.email = t("errors.emailRequired");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = t("errors.emailInvalid");
  }

  const amount = parseDonationAmount(values.amount);
  if (!amount.ok) {
    switch (amount.error) {
      case "required":
        errors.amount = t("errors.amountRequired");
        break;
      case "belowMin":
        errors.amount = amountLimitMessages.belowMin;
        break;
      case "aboveMax":
        errors.amount = amountLimitMessages.aboveMax;
        break;
      default:
        errors.amount = t("errors.amountInvalid");
    }
  }

  return errors;
}

/**
 * Toast copy for a failed donate-intent call. A 400 / 422 is the API's
 * schema validator speaking (`body/amountCents must be <= 1000000`) —
 * developer text, English-only, never donor copy — so it maps to a
 * translated generic message. Client-side validation mirrors the API
 * bounds, so reaching this branch means drift, not a donor mistake.
 */
function resolveIntentErrorMessage(error: unknown, t: ReturnType<typeof useTranslations>): string {
  if (!(error instanceof ApiProblem)) return t("errors.generic");
  if (error.status === 400 || error.status === 422) return t("errors.validation");
  return error.detail ?? error.title ?? t("errors.generic");
}

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `public-donation-${Date.now()}`;
}

/**
 * Render the donor's post-3DS-return state (issue #197). This intentionally
 * mirrors the Payment Element's success styling for `succeeded`, exposes a
 * retry path for `requires_action`, and degrades gracefully on `processing`
 * / `failed`.
 */
function PostRedirectView({
  state,
  colorPrimary,
  locale,
  publishableKey,
  tenantStripeAccountId,
  onDismiss,
}: {
  state: NonNullable<PostRedirectState>;
  colorPrimary: string;
  locale: string;
  publishableKey: string | null;
  tenantStripeAccountId: string | null;
  onDismiss: () => void;
}) {
  const t = useTranslations("publicDonationPage.payment");

  if (state.kind === "checking") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-6 flex items-center gap-3 rounded-2xl border border-outline-variant bg-surface px-4 py-5 text-sm text-on-surface-variant"
      >
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
        {t("postRedirect.checking")}
      </div>
    );
  }

  if (state.kind === "succeeded") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-6 flex flex-col items-start gap-3 rounded-2xl border border-outline-variant bg-surface px-4 py-5 text-sm text-on-surface"
      >
        <span
          className="inline-flex h-10 w-10 items-center justify-center rounded-full"
          style={{ backgroundColor: `color-mix(in srgb, ${colorPrimary} 18%, white)` }}
        >
          <CheckCircle2 size={20} style={{ color: colorPrimary }} aria-hidden="true" />
        </span>
        <p className="font-medium text-on-surface">{t("success.title")}</p>
        <p className="text-on-surface-variant">
          {t("success.body", {
            amount: formatCurrency(state.amountCents, locale, state.currency),
          })}
        </p>
      </div>
    );
  }

  if (state.kind === "processing") {
    return <PaymentProcessingNotice className="mt-6" />;
  }

  if (state.kind === "requires_action") {
    // Donor's 3DS attempt didn't complete. Re-mount the Payment Element
    // against the SAME intent so they can pick a different card without
    // creating a duplicate PaymentIntent on the connected account.
    if (!publishableKey || !tenantStripeAccountId) {
      return (
        <p className="mt-6 rounded-2xl border border-error bg-error-container px-4 py-3 text-sm text-on-error-container">
          {t("errors.missingPublishableKey")}
        </p>
      );
    }
    return (
      <div className="mt-6 space-y-4">
        <div
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-error bg-error-container px-4 py-3 text-sm text-on-error-container"
        >
          {t("postRedirect.requiresAction")}
        </div>
        <PublicDonationPaymentStep
          clientSecret={state.clientSecret}
          stripeAccountId={tenantStripeAccountId}
          publishableKey={publishableKey}
          colorPrimary={colorPrimary}
          amountSummary={formatCurrency(state.amountCents, locale, state.currency)}
          onPaid={() => {
            toast.success(t("success.title"));
          }}
          onBack={onDismiss}
        />
      </div>
    );
  }

  // state.kind === "failed"
  return (
    <div className="mt-6 space-y-3">
      <div
        role="alert"
        className="rounded-2xl border border-error bg-error-container px-4 py-3 text-sm text-on-error-container"
      >
        {state.message ?? t(`postRedirect.failed.${state.reason}`)}
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t("postRedirect.startOver")}
      </Button>
    </div>
  );
}
