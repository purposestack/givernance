/**
 * BCP-47 locale resolution for email job payloads (issue #153).
 *
 * Returns `APP_DEFAULT_LOCALE` ('fr') if the payload doesn't carry a
 * supported locale — the email still goes out, the user just sees the
 * app's default language.
 *
 * Lives in its own module so the unit test can import it without booting
 * the worker singletons that fire at the bottom of `worker.ts`.
 */

import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";

export function resolvePayloadLocale(payload: Record<string, unknown>): Locale {
  return isSupportedLocale(payload.locale) ? payload.locale : APP_DEFAULT_LOCALE;
}
