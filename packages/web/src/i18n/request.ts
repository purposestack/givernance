import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

/**
 * Supported locales — ADR-015: fr (default), en for Phase 2.
 * Add 'de', 'nl' in Phase 3, 'ar' in Phase 4+.
 */
const SUPPORTED_LOCALES = ["fr", "en"] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: Locale = "fr";

function isValidLocale(value: unknown): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
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
