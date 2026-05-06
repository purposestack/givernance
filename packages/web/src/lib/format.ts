/**
 * Centralized formatting utilities — ADR-015.
 * Uses Intl APIs driven by locale, following the formatting conventions
 * defined in docs/glossary-i18n.md.
 */

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

/** Format a number with locale-appropriate thousands separators. */
export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Format a percentage with locale-appropriate spacing. */
export function formatPercent(value: number, locale: string, decimals = 0): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}

/**
 * Return the currency symbol for a given ISO 4217 currency code.
 * Uses Intl.NumberFormat to derive the symbol so it stays in sync with
 * the browser locale without hard-coding a mapping table.
 */
export function getCurrencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? currency;
}
