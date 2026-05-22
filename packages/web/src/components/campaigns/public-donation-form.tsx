"use client";

import { CheckCircle2, HeartHandshake, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { PublicDonationPaymentStep } from "@/components/campaigns/public-donation-payment-step";
import { retrievePostRedirectIntent } from "@/components/campaigns/public-donation-post-redirect";
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
  /**
   * Epic #416 — dynamic currency list from `GET /v1/campaigns/:id/checkout-config`.
   * When provided (flag on), replaces the hardcoded `PUBLIC_DONATION_CURRENCIES`
   * list. The selected currency is persisted in sessionStorage under
   * `"givernance_donation_currency"` so the donor's choice survives a
   * 3DS redirect back to the same page.
   *
   * TODO: Future work — validate against Stripe minimum amounts per currency.
   *       The checkout-config endpoint does not yet return min amounts; add
   *       client-side validation here once the API exposes them.
   */
  presentmentCurrencies?: string[];
  /**
   * Epic #416 — the campaign's settlement currency (informational). Not
   * currently shown in the UI but forwarded for future display ("you're
   * donating in EUR; we settle in CHF") and Stripe minimum validation.
   */
  settlementCurrency?: string;
}

interface PublicDonationFormValues {
  firstName: string;
  lastName: string;
  email: string;
  amount: string;
  /**
   * Widened to `string` to accommodate dynamic currencies from the
   * checkout-config endpoint (Epic #416). When `presentmentCurrencies`
   * is not provided the value is always a `PublicDonationCurrency` from
   * the hardcoded list; when it is provided it may be any IETF currency
   * code returned by the API.
   */
  currency: string;
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
  currency: string;
}

/**
 * Outcome resolved from `?payment_intent_client_secret=…` query params on
 * mount — i.e., the donor was redirected here after a 3DS challenge. See
 * `public-donation-post-redirect.ts` for the full type and rationale.
 */
type PostRedirectState =
  | { kind: "checking" }
  | { kind: "succeeded"; amountCents: number; currency: string }
  | {
      kind: "requires_action";
      clientSecret: string;
      amountCents: number;
      currency: string;
    }
  | { kind: "processing" }
  | { kind: "failed"; message: string }
  | null;

const SUGGESTED_AMOUNTS = [25, 50, 100] as const;

const DEFAULT_VALUES: PublicDonationFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  amount: "",
  currency: "EUR",
};
const PUBLIC_DONATION_CURRENCIES: PublicDonationCurrency[] = ["EUR", "GBP", "CHF"];

const SESSION_STORAGE_CURRENCY_KEY = "givernance_donation_currency";

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
  presentmentCurrencies,
  settlementCurrency: _settlementCurrency,
}: PublicDonationFormProps) {
  const t = useTranslations("publicDonationPage.form");
  const tPayment = useTranslations("publicDonationPage.payment");

  // Epic #416 — resolve initial currency from sessionStorage when
  // presentmentCurrencies is provided (dynamic list). Only restore
  // if the stored value is still in the current list to avoid
  // presenting an unsupported currency after a config change.
  const effectiveCurrencies =
    presentmentCurrencies && presentmentCurrencies.length > 0
      ? presentmentCurrencies
      : PUBLIC_DONATION_CURRENCIES;

  const resolvedInitialCurrency = (): string => {
    if (presentmentCurrencies && presentmentCurrencies.length > 0) {
      const stored =
        typeof window !== "undefined"
          ? window.sessionStorage.getItem(SESSION_STORAGE_CURRENCY_KEY)
          : null;
      if (stored && presentmentCurrencies.includes(stored)) {
        return stored;
      }
    }
    return defaultCurrency;
  };

  const [values, setValues] = useState<PublicDonationFormValues>({
    ...DEFAULT_VALUES,
    currency: resolvedInitialCurrency(),
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
        setPostRedirect({ kind: "failed", message: tPayment("errors.generic") });
      });

    return () => {
      active = false;
    };
    // tPayment is stable per locale; we intentionally fire this once on mount.
  }, [postRedirect, publishableKey, tenantStripeAccountId, tPayment]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors = validate(values, t);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);

    try {
      const amountCents = parseAmountToCents(values.amount);
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
      const message =
        error instanceof ApiProblem
          ? (error.detail ?? error.title ?? t("errors.generic"))
          : t("errors.generic");
      toast.error(message);
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
          currencies={effectiveCurrencies}
          onValuesChange={(updater) => {
            setValues((current) => {
              const next = updater(current);
              // Epic #416 — persist currency selection in sessionStorage
              // when a dynamic list is active, so a 3DS redirect back to
              // this page restores the donor's choice.
              if (
                presentmentCurrencies &&
                presentmentCurrencies.length > 0 &&
                next.currency !== current.currency &&
                typeof window !== "undefined"
              ) {
                window.sessionStorage.setItem(SESSION_STORAGE_CURRENCY_KEY, next.currency);
              }
              return next;
            });
          }}
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
  currencies,
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
  /** Effective currency list — either dynamic (Epic #416) or hardcoded fallback. */
  currencies: readonly string[];
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
            inputId="public-donation-first-name"
            label={t("fields.firstName")}
            error={errors.firstName}
            required
            input={
              <Input
                id="public-donation-first-name"
                value={values.firstName}
                onChange={(event) => {
                  onValuesChange((current) => ({ ...current, firstName: event.target.value }));
                  onErrorsChange((current) => ({ ...current, firstName: undefined }));
                }}
                placeholder={t("fields.firstNamePlaceholder")}
                aria-invalid={Boolean(errors.firstName)}
                autoComplete="given-name"
              />
            }
          />
          <Field
            inputId="public-donation-last-name"
            label={t("fields.lastName")}
            error={errors.lastName}
            required
            input={
              <Input
                id="public-donation-last-name"
                value={values.lastName}
                onChange={(event) => {
                  onValuesChange((current) => ({ ...current, lastName: event.target.value }));
                  onErrorsChange((current) => ({ ...current, lastName: undefined }));
                }}
                placeholder={t("fields.lastNamePlaceholder")}
                aria-invalid={Boolean(errors.lastName)}
                autoComplete="family-name"
              />
            }
          />
        </div>

        <Field
          inputId="public-donation-email"
          label={t("fields.email")}
          error={errors.email}
          required
          input={
            <Input
              id="public-donation-email"
              type="email"
              value={values.email}
              onChange={(event) => {
                onValuesChange((current) => ({ ...current, email: event.target.value }));
                onErrorsChange((current) => ({ ...current, email: undefined }));
              }}
              placeholder={t("fields.emailPlaceholder")}
              aria-invalid={Boolean(errors.email)}
              autoComplete="email"
            />
          }
        />

        <Field
          inputId="public-donation-amount"
          label={t("fields.amount")}
          error={errors.amount}
          required
          input={
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-variant">
                {getCurrencySymbol(values.currency)}
              </span>
              <Input
                id="public-donation-amount"
                type="number"
                min="1"
                step="1"
                value={values.amount}
                onChange={(event) => {
                  onValuesChange((current) => ({ ...current, amount: event.target.value }));
                  onErrorsChange((current) => ({ ...current, amount: undefined }));
                }}
                placeholder={t("fields.amountPlaceholder")}
                aria-invalid={Boolean(errors.amount)}
                className="pl-7"
                inputMode="decimal"
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
                  currency,
                }))
              }
            >
              <SelectTrigger id="public-donation-currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencies.map((currency) => (
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

function getCurrencySymbol(currency: string): string {
  switch (currency) {
    case "GBP":
      return "£";
    case "CHF":
      return "CHF";
    default:
      // For all other currencies (EUR, USD, SEK, NOK, DKK, PLN, CZK, HUF,
      // JPY, and any future dynamic currencies from checkout-config), fall
      // back to the Intl-formatted symbol. Using `€` as the ultimate fallback
      // keeps the previous behaviour for EUR which is the most common case.
      try {
        return (
          new Intl.NumberFormat("en", {
            style: "currency",
            currency,
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })
            .formatToParts(0)
            .find((p) => p.type === "currency")?.value ?? currency
        );
      } catch {
        return currency;
      }
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
      {error ? <span className="block text-sm text-error">{error}</span> : null}
    </div>
  );
}

function validate(
  values: PublicDonationFormValues,
  t: ReturnType<typeof useTranslations>,
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

  const amount = Number(values.amount);
  if (!values.amount.trim()) {
    errors.amount = t("errors.amountRequired");
  } else if (!Number.isFinite(amount) || amount < 1) {
    errors.amount = t("errors.amountInvalid");
  }

  return errors;
}

function parseAmountToCents(value: string): number {
  return Math.round(Number(value) * 100);
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
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-6 rounded-2xl border border-outline-variant bg-surface px-4 py-3 text-sm text-on-surface-variant"
      >
        {t("postRedirect.processing")}
      </div>
    );
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
        {state.message}
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t("postRedirect.startOver")}
      </Button>
    </div>
  );
}
