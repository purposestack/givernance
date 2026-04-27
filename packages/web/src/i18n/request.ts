import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { createServerApiClient } from "@/lib/api/client-server";

/**
 * Supported locales — ADR-015: fr (default), en for Phase 2.
 * Add 'de', 'nl' in Phase 3, 'ar' in Phase 4+.
 *
 * Issue #153: the supported set + default come from
 * `@givernance/shared/i18n` so the API CHECK constraints, the worker
 * email selector, and this resolver cannot drift from each other.
 */
const DEFAULT_LOCALE: Locale = APP_DEFAULT_LOCALE;

function isValidLocale(value: unknown): value is Locale {
  return isSupportedLocale(value);
}

/**
 * Try to resolve the active locale from `/v1/users/me`. Returns the
 * authoritative server-side answer (3-layer chain: `users.locale ??
 * tenants.default_locale ?? APP_DEFAULT_LOCALE`) when the caller is
 * authenticated, or `null` when:
 *
 *  - No `givernance_jwt` cookie is set (unauthenticated route).
 *  - The API call fails (network, 401 from a stale cookie, 5xx).
 *  - The response shape is missing the locale fields (defensive).
 *
 * Failures fall through to the cookie / Accept-Language chain so the
 * resolver never hard-errors a page render. Issue #153 / PR #158
 * follow-up — the cookie-only path was leaving the UI stuck in
 * Accept-Language's locale even after the user changed their
 * preference via /profile.
 */
async function resolveSessionLocale(): Promise<Locale | null> {
  const cookieStore = await cookies();
  if (!cookieStore.get("givernance_jwt")?.value) return null;

  try {
    const api = await createServerApiClient();
    const res = await api.get<{
      data?: { locale?: unknown; tenantDefaultLocale?: unknown };
    }>("/v1/users/me");
    const personal = res.data?.locale;
    if (isValidLocale(personal)) return personal;
    const tenantDefault = res.data?.tenantDefaultLocale;
    if (isValidLocale(tenantDefault)) return tenantDefault;
    return null;
  } catch {
    // Stale JWT, network blip, 5xx — fall through.
    return null;
  }
}

/**
 * Resolve the active locale from (in priority order):
 *  1. `/v1/users/me` (authenticated routes — `users.locale ??
 *     tenants.default_locale`). Source of truth.
 *  2. `NEXT_LOCALE` cookie — used by the unauthenticated `(auth)`
 *     surfaces (`/login`, `/signup`, `/invite/accept`) where there's no
 *     session yet.
 *  3. `Accept-Language` header — last-mile fallback for first-time
 *     visitors with no cookie.
 *  4. `APP_DEFAULT_LOCALE` ('fr', per ADR-015).
 */
async function resolveLocale(): Promise<Locale> {
  const sessionLocale = await resolveSessionLocale();
  if (sessionLocale) return sessionLocale;

  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  if (isValidLocale(cookieLocale)) return cookieLocale;

  const headerStore = await headers();
  const acceptLanguage = headerStore.get("accept-language") ?? "";
  for (const part of acceptLanguage.split(",")) {
    const lang = part.split(";")[0]?.trim().split("-")[0];
    if (isValidLocale(lang)) return lang;
  }

  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
