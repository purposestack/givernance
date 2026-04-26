/**
 * Locale registry — single source of truth for the supported BCP-47 tags
 * and the application default. Imported by:
 *
 *  - The Drizzle CHECK constraints on `tenants.default_locale` and
 *    `users.locale` (both validated server-side in service code, since
 *    Postgres CHECKs reference the literal values directly in the
 *    migration SQL — keep this constant and that migration in lockstep).
 *  - TypeBox / Zod validators on the public API surfaces that accept a
 *    locale field (signup body, invite-accept body, future profile
 *    PATCH).
 *  - The worker's email-template selector — `payload.locale` is the
 *    enqueue-time-resolved BCP-47 string; the worker no longer infers
 *    it from country.
 *  - The web's next-intl config (`packages/web/src/i18n/request.ts`)
 *    so the frontend cannot drift from the API-supported set.
 *
 * Issue #153 / ADR-015 amendment.
 */

export const SUPPORTED_LOCALES = ["fr", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Application default locale — the floor in the 3-layer resolution chain
 * `user.locale ?? tenant.default_locale ?? APP_DEFAULT_LOCALE`. Per
 * ADR-015 (French-first, primary market is French NPOs). Tenants land
 * here only when the creator explicitly omits the locale and we have no
 * country signal to derive from; the migration backfill uses this same
 * value for enterprise-seeded rows that never had a signup event.
 */
export const APP_DEFAULT_LOCALE: Locale = "fr";

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Map an ISO-3166-1 alpha-2 country code to a default locale, used when
 * a tenant is created without an explicit `locale` choice. Mirror of
 * the migration backfill rule (FR → fr, anything else → en) so a
 * pre-existing FR-signup tenant and a brand-new FR-signup tenant land
 * on the same `default_locale`. Returns `APP_DEFAULT_LOCALE` for
 * `undefined` / `null` so enterprise-seeded tenants get the floor.
 */
export function localeFromCountry(country: string | null | undefined): Locale {
  if (!country) return APP_DEFAULT_LOCALE;
  return country.toUpperCase() === "FR" ? "fr" : "en";
}
