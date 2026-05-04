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
 * Return the display symbol for a supported donation currency.
 * Used to drive the `currencySymbol` prop on `<AmountInput>` so the
 * prefix tracks the selected currency in real time.
 *
 * Covers the 8 currencies accepted by the donation form.
 * Falls back to the ISO code for any unlisted value so new currencies
 * added to the form don't silently show `€`.
 */
export function getCurrencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case "GBP":
      return "£";
    case "CHF":
      return "CHF";
    case "SEK":
    case "NOK":
    case "DKK":
      return "kr";
    case "PLN":
      return "zł";
    case "CZK":
      return "Kč";
    default:
      return "€"; // EUR and any unknown currency
  }
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
