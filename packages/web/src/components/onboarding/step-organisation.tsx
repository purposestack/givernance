"use client";

import { ArrowRight, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { type ActionResult, saveOrganisationAction } from "@/app/onboarding/actions";
import {
  LEGAL_TYPES,
  ONBOARDING_COUNTRIES,
  ONBOARDING_CURRENCIES,
  type Tenant,
} from "@/models/tenant";

export interface StepOrganisationProps {
  /** Tenant prefill (null on first visit). */
  initialTenant: Tenant | null;
  /** Advance to the next step — receives the saved tenant so the parent can hydrate it. */
  onSaved: (tenant: Tenant) => void;
}

/**
 * Step 1 — Organisation.
 * Form captures org name, country, legal type, currency, and registration number.
 * Submits via a server action (`saveOrganisationAction`) to `POST /v1/tenants/me/onboarding`.
 */
export function StepOrganisation({ initialTenant, onSaved }: StepOrganisationProps) {
  const t = useTranslations("onboarding.step1");
  const tActions = useTranslations("onboarding.actions");

  const initialState: ActionResult<Tenant> = { ok: false };
  const [state, formAction, isPending] = useActionState(
    async (prev: ActionResult<Tenant> | undefined, formData: FormData) => {
      const result = await saveOrganisationAction(prev, formData);
      if (result.ok && result.data) onSaved(result.data);
      return result;
    },
    initialState,
  );

  const nameId = useId();
  const countryId = useId();
  const legalTypeId = useId();
  const currencyId = useId();
  const regId = useId();

  const errs = state.fieldErrors ?? {};
  const nameError =
    errs.name === "required"
      ? t("errors.name.required")
      : errs.name === "tooLong"
        ? t("errors.name.tooLong")
        : undefined;
  const countryError = errs.country === "required" ? t("errors.country.required") : undefined;
  const legalTypeError = errs.legalType === "required" ? t("errors.legalType.required") : undefined;
  const currencyError = errs.currency === "required" ? t("errors.currency.required") : undefined;
  const regError =
    errs.registrationNumber === "tooLong" ? t("errors.registrationNumber.tooLong") : undefined;

  return (
    <form action={formAction} noValidate>
      <div className="mb-6 text-center">
        <h1 className="mb-2 font-heading text-2xl text-text">{t("title")}</h1>
        <p className="text-sm text-text-secondary">{t("subtitle")}</p>
      </div>

      {state.errorKey === "saveFailed" && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("errors.saveFailed")}</span>
        </div>
      )}

      <div className="rounded-card bg-surface-container-lowest p-8 shadow-card">
        <div className="mb-5">
          <label htmlFor={nameId} className="mb-2 block text-sm font-medium text-text">
            {t("nameLabel")}
            <span className="ml-1 text-error">*</span>
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            required
            maxLength={255}
            defaultValue={initialTenant?.name ?? ""}
            placeholder={t("namePlaceholder")}
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? `${nameId}-error` : undefined}
            className="h-10 w-full rounded-input border border-border bg-surface-container-lowest px-3 text-sm text-text placeholder:text-text-muted focus-visible:border-primary focus-visible:outline-none"
          />
          {nameError && (
            <p id={`${nameId}-error`} className="mt-1 text-xs text-error">
              {nameError}
            </p>
          )}
        </div>

        <div className="mb-5 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor={countryId} className="mb-2 block text-sm font-medium text-text">
              {t("countryLabel")}
              <span className="ml-1 text-error">*</span>
            </label>
            <select
              id={countryId}
              name="country"
              required
              defaultValue={initialTenant?.country ?? ""}
              aria-invalid={Boolean(countryError)}
              aria-describedby={countryError ? `${countryId}-error` : undefined}
              className="h-10 w-full rounded-input border border-border bg-surface-container-lowest px-3 text-sm text-text focus-visible:border-primary focus-visible:outline-none"
            >
              <option value="" disabled>
                {t("countryPlaceholder")}
              </option>
              {ONBOARDING_COUNTRIES.map((code) => (
                <option key={code} value={code}>
                  {t(`countries.${code}`)}
                </option>
              ))}
            </select>
            {countryError && (
              <p id={`${countryId}-error`} className="mt-1 text-xs text-error">
                {countryError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={legalTypeId} className="mb-2 block text-sm font-medium text-text">
              {t("legalTypeLabel")}
              <span className="ml-1 text-error">*</span>
            </label>
            <select
              id={legalTypeId}
              name="legalType"
              required
              defaultValue={initialTenant?.legalType ?? ""}
              aria-invalid={Boolean(legalTypeError)}
              aria-describedby={legalTypeError ? `${legalTypeId}-error` : undefined}
              className="h-10 w-full rounded-input border border-border bg-surface-container-lowest px-3 text-sm text-text focus-visible:border-primary focus-visible:outline-none"
            >
              <option value="" disabled>
                {t("legalTypePlaceholder")}
              </option>
              {LEGAL_TYPES.map((code) => (
                <option key={code} value={code}>
                  {t(`legalTypes.${code}`)}
                </option>
              ))}
            </select>
            {legalTypeError && (
              <p id={`${legalTypeId}-error`} className="mt-1 text-xs text-error">
                {legalTypeError}
              </p>
            )}
          </div>
        </div>

        <div className="mb-5 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor={currencyId} className="mb-2 block text-sm font-medium text-text">
              {t("currencyLabel")}
              <span className="ml-1 text-error">*</span>
            </label>
            <select
              id={currencyId}
              name="currency"
              required
              defaultValue={initialTenant?.currency ?? "EUR"}
              aria-invalid={Boolean(currencyError)}
              aria-describedby={currencyError ? `${currencyId}-error` : undefined}
              className="h-10 w-full rounded-input border border-border bg-surface-container-lowest px-3 text-sm text-text focus-visible:border-primary focus-visible:outline-none"
            >
              {ONBOARDING_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {t(`currencies.${code}`)}
                </option>
              ))}
            </select>
            {currencyError && (
              <p id={`${currencyId}-error`} className="mt-1 text-xs text-error">
                {currencyError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={regId} className="mb-2 block text-sm font-medium text-text">
              {t("registrationNumberLabel")}
            </label>
            <input
              id={regId}
              name="registrationNumber"
              type="text"
              maxLength={100}
              defaultValue={initialTenant?.registrationNumber ?? ""}
              placeholder={t("registrationNumberPlaceholder")}
              aria-invalid={Boolean(regError)}
              aria-describedby={regError ? `${regId}-error` : `${regId}-hint`}
              className="h-10 w-full rounded-input border border-border bg-surface-container-lowest px-3 text-sm text-text placeholder:text-text-muted focus-visible:border-primary focus-visible:outline-none"
            />
            {regError && (
              <p id={`${regId}-error`} className="mt-1 text-xs text-error">
                {regError}
              </p>
            )}
            <p id={`${regId}-hint`} className="mt-1 text-xs text-text-muted">
              {t("registrationNumberHint")}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-end gap-4">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-[var(--btn-height-lg)] items-center gap-2 rounded-button bg-primary px-6 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? tActions("saving") : tActions("continue")}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
