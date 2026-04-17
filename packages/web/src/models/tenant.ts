/**
 * Tenant domain types (ADR-011 Layer 1 — models).
 *
 * Frontend-local types only — ADR-013 forbids importing `@givernance/shared/schema`
 * in the web package. These mirror the shape returned by `GET /v1/tenants/me`.
 */

/** ISO 3166-1 alpha-2 country codes accepted by the onboarding wizard (EU + EEA + CH/GB). */
export const ONBOARDING_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
  "CH",
  "NO",
  "IS",
  "LI",
] as const;

export type CountryCode = (typeof ONBOARDING_COUNTRIES)[number];

export const LEGAL_TYPES = [
  "asso1901",
  "fondation",
  "frup",
  "asbl",
  "ong",
  "cooperative",
  "autre",
] as const;

export type LegalType = (typeof LEGAL_TYPES)[number];

export const ONBOARDING_CURRENCIES = [
  "EUR",
  "GBP",
  "CHF",
  "NOK",
  "SEK",
  "DKK",
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "BGN",
] as const;

export type OnboardingCurrency = (typeof ONBOARDING_CURRENCIES)[number];

/** Shape of a tenant as returned by `GET /v1/tenants/me`. */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  country: CountryCode | null;
  legalType: LegalType | null;
  currency: OnboardingCurrency;
  registrationNumber: string | null;
  logoUrl: string | null;
  onboardingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST /v1/tenants/me/onboarding`. */
export interface OnboardingStep1Input {
  name: string;
  country: CountryCode;
  legalType: LegalType;
  currency: OnboardingCurrency;
  registrationNumber?: string;
}
