/**
 * Centralized formatting utilities — ADR-015.
 * Uses Intl APIs driven by locale, following the formatting conventions
 * defined in docs/glossary-i18n.md.
 */

/** Format a monetary amount in cents to a localized currency string. */
export function formatCurrency(cents: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
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
