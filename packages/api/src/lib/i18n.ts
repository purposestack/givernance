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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";

const SUPPORTED_LOCALES = ["fr", "en"] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: Locale = "fr";

type Messages = Record<string, Record<string, string>>;

const messageCache = new Map<Locale, Messages>();

function loadMessages(locale: Locale): Messages {
  const cached = messageCache.get(locale);
  if (cached) return cached;

  const filePath = join(__dirname, "../../messages", `${locale}.json`);
  const messages = JSON.parse(readFileSync(filePath, "utf-8")) as Messages;
  messageCache.set(locale, messages);
  return messages;
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
