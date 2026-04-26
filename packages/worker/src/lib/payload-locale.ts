/**
 * BCP-47 locale resolution for email job payloads (issue #153).
 *
 * The API stamps `locale` on every signup/invitation outbox payload after
 * #158 lands. For one transitional release we still accept the legacy
 * `country` field so jobs already enqueued before the upgrade render
 * correctly: same FR→fr / else-→en mapping the prior worker used. Once
 * the queue has drained post-deploy, a follow-up cleanup PR removes the
 * country branch (tracked separately).
 *
 * Returns `APP_DEFAULT_LOCALE` ('fr') if the payload carries neither —
 * the email still goes out, the user just sees the app's default
 * language. We log a warn so SRE can spot legacy producers, but do not
 * throw (the worker would retry until the attempt budget is exhausted
 * and the email would never land).
 *
 * Lives in its own module so the unit test can import it without booting
 * the worker singletons that fire at the bottom of `worker.ts`.
 */

import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";

/** Minimal shape of the structured logger this helper needs. */
export interface PayloadLocaleLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export function resolvePayloadLocale(
  payload: Record<string, unknown>,
  log: PayloadLocaleLogger,
): Locale {
  if (isSupportedLocale(payload.locale)) return payload.locale;
  if (typeof payload.country === "string" && payload.country.trim().length > 0) {
    log.warn(
      { country: payload.country },
      "Email job carries legacy `country` only; falling back to country-derived locale (issue #153 transitional)",
    );
    return payload.country.toUpperCase() === "FR" ? "fr" : "en";
  }
  log.warn({}, "Email job carries no `locale` or `country`; falling back to APP_DEFAULT_LOCALE");
  return APP_DEFAULT_LOCALE;
}
