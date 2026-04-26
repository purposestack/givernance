import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

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
 * Resolve the active locale from (in priority order):
 * 1. NEXT_LOCALE cookie (set by org settings or user preference)
 * 2. Accept-Language header
 * 3. Default: 'fr'
 */
async function resolveLocale(): Promise<Locale> {
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
