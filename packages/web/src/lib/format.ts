/**
 * Centralized formatting utilities — ADR-015.
 * Uses Intl APIs driven by locale, following the formatting conventions
 * defined in docs/glossary-i18n.md.
 */

import { APP_DEFAULT_LOCALE } from "@givernance/shared/i18n";
import { DONATION_CURRENCY_VALUES, MULTI_CURRENCY_VALUES } from "@givernance/shared/validators";

/**
 * Last-resort locale when no user/tenant locale is in scope. Reuses the
 * application default from the shared i18n registry (the floor of the
 * `user.locale ?? tenant.default_locale ?? APP_DEFAULT_LOCALE` chain) so
 * currency formatting never invents its own default.
 */
export const DEFAULT_LOCALE = APP_DEFAULT_LOCALE;

// ─── Allowed-currency themes ────────────────────────────────────────────────
// Each "theme" is the set of currencies valid for one surface. The base arrays
// are derived from `@givernance/shared` so the web pickers and the API
// validators can never drift (ADR-013 permits importing shared constants).

/**
 * Settlement currencies — tenant base currency, campaign default currency
 * (ADR-032). Derived from the shared `MULTI_CURRENCY_VALUES`.
 */
export const SETTLEMENT_CURRENCIES = MULTI_CURRENCY_VALUES;
export type SettlementCurrency = (typeof SETTLEMENT_CURRENCIES)[number];

/**
 * Bank-account currencies — the Swiss QR-bill subset (Epic #318). A bank
 * account settles in CHF or EUR only.
 */
export const BANK_ACCOUNT_CURRENCIES = ["CHF", "EUR"] as const;
export type BankAccountCurrency = (typeof BANK_ACCOUNT_CURRENCIES)[number];

/**
 * Donation currencies — accepted on a manual/offline donation entry. The
 * full Stripe-settleable set (8 codes), derived from the shared
 * `DONATION_CURRENCY_VALUES`.
 */
export const DONATION_CURRENCIES = DONATION_CURRENCY_VALUES;
export type DonationCurrency = (typeof DONATION_CURRENCIES)[number];

/**
 * Presentment currencies — the donor-facing superset shown on a public
 * donation page. This is the STATIC FALLBACK only; when
 * `donation.multi_currency` is enabled the live list comes from
 * `GET /v1/campaigns/:id/checkout-config` (Epic #416 / task #409), filtered
 * by `currency_metadata.enabled`.
 */
export const PRESENTMENT_CURRENCIES = [
  "EUR",
  "GBP",
  "CHF",
  "USD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "HUF",
  "JPY",
] as const;
export type PresentmentCurrency = (typeof PRESENTMENT_CURRENCIES)[number];

/** Super-admin finance filter — settlement currencies plus the "all" pseudo-option. */
export const FINANCE_FILTER_CURRENCIES = [...SETTLEMENT_CURRENCIES, "all"] as const;
export type FinanceFilterCurrency = (typeof FINANCE_FILTER_CURRENCIES)[number];

/**
 * Platform reporting base currency — the display currency for cross-currency
 * aggregates that have no per-row currency (e.g. the super-admin finance
 * "all currencies" view). Replaces the inline `"EUR"` literals.
 */
export const PLATFORM_BASE_CURRENCY = "EUR" as const;

/**
 * Resolve the localized symbol for an ISO 4217 currency code (e.g. `£`,
 * `CHF`, `€`). Consolidates the hand-rolled symbol switches that used to
 * live in the donation form and the amount input. Returns the code itself
 * if Intl cannot produce a symbol.
 */
export function getCurrencySymbol(currency: string, locale: string = DEFAULT_LOCALE): string {
  return (
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency
  );
}

/**
 * Format a monetary amount in cents to a localized currency string.
 * Always renders two decimals — `€1 000,00` reads consistently next to
 * `€1 234,56` in a table column, and matches accounting convention.
 */
export function formatCurrency(cents: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Format a monetary amount in cents to a rounded currency string with no decimals.
 * Intended for KPI / stat-card contexts where `€12 345` is cleaner than `€12 345,00`.
 * Do NOT use in tables or accounting views — use `formatCurrency` there.
 */
export function formatCurrencyRounded(cents: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Format a date to a localized string. */
export function formatDate(
  date: string | Date,
  locale: string,
  style: "short" | "medium" | "long" = "medium",
): string {
  const d = typeof date === "string" ? new Date(date) : date;

  const options: Intl.DateTimeFormatOptions =
    style === "short"
      ? { day: "2-digit", month: "2-digit", year: "numeric" }
      : style === "long"
        ? { day: "numeric", month: "long", year: "numeric" }
        : { day: "numeric", month: "short", year: "numeric" };

  return new Intl.DateTimeFormat(locale, options).format(d);
}

/**
 * Format a `YYYY-MM` period string to a localized, capitalized month + year
 * label — `2026-05` → `Mai 2026` (fr) / `May 2026` (en).
 *
 * Used for operator-facing period labels (e.g. the finance report archive)
 * where the raw `YYYY-MM` reads as machine-oriented. The underlying value is
 * kept for sorting; only the display text is humanized here.
 *
 * Constructs the date at midday UTC of the 1st so the rendered month never
 * drifts across a timezone boundary. Returns the input unchanged if it is not
 * a well-formed `YYYY-MM` string.
 */
export function formatMonthYear(month: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return month;

  const formatted = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthIndex, 1, 12)));

  // Intl lowercases the month name in some locales (fr: "mai 2026"); the
  // archive list wants a capitalized leading letter ("Mai 2026").
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/**
 * Format a `YYYY-MM` period string to just the localized, capitalized month
 * name — `2026-05` → `Mai` (fr) / `May` (en). Intended for lists already
 * grouped under a year heading, where repeating the year on every row is
 * redundant. Returns the input unchanged if it is not a well-formed
 * `YYYY-MM` string.
 */
export function formatMonthName(month: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;

  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return month;

  const formatted = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, monthIndex, 1, 12)));

  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/** Format a number with locale-appropriate thousands separators. */
export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * Format a plain number with a fixed number of fraction digits (locale-aware).
 * For values that already carry their own unit in surrounding markup — e.g. a
 * percentage where the `%` glyph is appended in JSX. Distinct from
 * `formatPercent`, which divides by 100 and emits the `%` itself.
 */
export function formatDecimal(value: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Format a percentage with locale-appropriate spacing. */
export function formatPercent(value: number, locale: string, decimals = 0): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}
