"use client";

import { HeartHandshake, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useState } from "react";

import { PublicDonationPaymentStep } from "@/components/campaigns/public-donation-payment-step";
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

  return (
    <section className="rounded-[28px] border border-outline-variant bg-surface-container-lowest p-6 shadow-card sm:p-7">
      <div className="flex items-center gap-3">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-2xl"
          style={{ backgroundColor: `color-mix(in srgb, ${colorPrimary} 16%, white)` }}
        >
          <HeartHandshake size={20} aria-hidden="true" style={{ color: colorPrimary }} />
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-on-surface-variant">
            {t("eyebrow")}
          </p>
          <h2 className="font-heading text-2xl text-on-surface">{t("title")}</h2>
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-on-surface-variant">{t("description")}</p>

      {session ? (
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
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {SUGGESTED_AMOUNTS.map((amount) => (
          <button
            key={amount}
            type="button"
            className="rounded-2xl border border-outline-variant bg-surface px-4 py-4 text-center transition-colors hover:border-primary sm:py-5"
            style={{
              backgroundColor: values.amount === String(amount) ? colorPrimary : undefined,
              color:
                values.amount === String(amount) ? getReadableTextColor(colorPrimary) : undefined,
            }}
            onClick={() => {
              onValuesChange((current) => ({ ...current, amount: String(amount) }));
              onErrorsChange((current) => ({ ...current, amount: undefined }));
            }}
          >
            <span className="block text-center text-lg font-semibold sm:text-xl">
              {new Intl.NumberFormat(locale, {
                style: "currency",
                currency: values.currency,
                maximumFractionDigits: 0,
              }).format(amount)}
            </span>
          </button>
        ))}
      </div>

      {goalAmountCents !== null ? (
        <p className="mt-4 text-sm text-on-surface-variant">
          {t("goal", { amount: formatCurrency(goalAmountCents, locale, defaultCurrency) })}
        </p>
      ) : null}

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
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

        <p className="text-center text-xs leading-5 text-on-surface-variant sm:text-left">
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
  return (
    <div className="block space-y-2">
      <label htmlFor={inputId} className="text-sm font-medium text-on-surface">
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

function getReadableTextColor(hex: string): "#FFFFFF" | "#111827" {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#FFFFFF";
}
