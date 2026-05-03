/**
 * Backend i18n helper — ADR-015.
 *
 * Resolves locale from Accept-Language header and provides
 * translated error messages for RFC 9457 Problem Details responses.
 *
 * Usage in route handlers:
 *   const t = resolveTranslations(request);
 *   reply.status(404).send({
 *     type: "about:blank",
 *     title: "Not Found",
 *     status: 404,
 *     detail: t("errors.notFound", { resource: t("resources.donation") }),
 *   });
 */

import type { FastifyRequest } from "fastify";
// JSON imports are inlined by tsup at build time so the bundled `dist/index.js`
// does not depend on the runtime location of the messages directory.
// Previously the loader used `readFileSync(join(__dirname, "../../messages", …))`,
// which silently broke in production: from `dist/index.js` the path resolved to
// `packages/messages/` (one level too high) and every route calling
// `resolveTranslations` 500ed with ENOENT.
import enMessages from "../../messages/en.json";
import frMessages from "../../messages/fr.json";

const SUPPORTED_LOCALES = ["fr", "en"] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: Locale = "fr";

type Messages = Record<string, Record<string, string>>;

const MESSAGES: Record<Locale, Messages> = {
  en: enMessages as Messages,
  fr: frMessages as Messages,
};

function loadMessages(locale: Locale): Messages {
  return MESSAGES[locale];
}

/**
 * Public-facing variant of {@link resolveLocale} that reads `Accept-Language`
 * from a Fastify request. Use when an outbound side-effect (an outbox email
 * payload, a Keycloak user attribute, etc.) needs to inherit the caller's
 * locale rather than just rendering an immediate Problem Details response.
 *
 * Returns the resolved supported locale (`fr`/`en`) — never throws, defaults
 * to `DEFAULT_LOCALE` when the header is absent or unparseable.
 */
export function resolveRequestLocale(request: FastifyRequest): Locale {
  return resolveLocale(request.headers["accept-language"]);
}

function resolveLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  for (const part of acceptLanguage.split(",")) {
    const lang = part.split(";")[0]?.trim().split("-")[0];
    if (lang && (SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
      return lang as Locale;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Create a translation function from a Fastify request.
 * Reads Accept-Language header to determine locale.
 *
 * @returns `t(key, params?)` — resolves dot-separated key with optional {placeholder} interpolation.
 */
export function resolveTranslations(request: FastifyRequest) {
  const locale = resolveLocale(request.headers["accept-language"]);
  const messages = loadMessages(locale);

  return function t(key: string, params?: Record<string, string>): string {
    const [namespace, ...rest] = key.split(".");
    const messageKey = rest.join(".");

    if (!namespace || !messageKey) return key;

    const value = messages[namespace]?.[messageKey];
    if (!value) return key;

    if (!params) return value;

    return Object.entries(params).reduce((str, [k, v]) => str.replace(`{${k}}`, v), value);
  };
}
