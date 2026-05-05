/**
 * Canonical list of currencies supported by Givernance.
 *
 * Single source of truth for:
 * - donation currency validation (DonationCreateSchema)
 * - tenant base currency (MultiCurrencySchema, PATCH /v1/tenants/:id)
 * - UI currency selectors and symbol rendering
 *
 * Kept in `@givernance/shared/constants` (not the schema entry point) so the
 * web package can import it without pulling the Drizzle schema (ADR-013).
 */

export const SUPPORTED_CURRENCIES = [
  "EUR",
  "GBP",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Currencies that can be configured as a tenant's base (pivot) currency.
 * Currently identical to SUPPORTED_CURRENCIES — any donation currency can also
 * be a base currency. Kept as a distinct constant so the type can diverge if
 * XOF/XAF (non-decimal) are added in future (Phase 4+, see P2 ADR).
 */
export const BASE_CURRENCIES = [...SUPPORTED_CURRENCIES] as const;
export type BaseCurrency = (typeof BASE_CURRENCIES)[number];

/**
 * Returns the currency symbol for a given ISO-4217 code using the browser/Node
 * Intl API. Falls back to the currency code itself if Intl is unavailable.
 *
 * Examples: "EUR" → "€", "GBP" → "£", "CHF" → "CHF", "SEK" → "kr"
 *
 * Note: the exact symbol depends on the `locale`. The default "en-US" gives
 * unambiguous symbols for European currencies (CHF stays "CHF", SEK "kr", etc.).
 */
export function getCurrencySymbol(currency: string, locale = "en-US"): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function isBaseCurrency(value: string): value is BaseCurrency {
  return (BASE_CURRENCIES as readonly string[]).includes(value);
}
