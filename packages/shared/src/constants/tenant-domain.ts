/**
 * Validator for `tenant_domains.domain` values (ADR-016 / doc 22 §4.2).
 * Shared between the API (server-side claim endpoint) and the web (client-side
 * feedback on the admin form) so both layers reject the exact same inputs.
 *
 * Rules:
 *  - Lowercased, trimmed, ASCII-only (IDNA punycode is OUT of scope — enterprise
 *    tenants claim `croix-rouge.fr`, not `xn--croix-rouge-xyz.fr`).
 *  - 1–253 characters total, each label 1–63 characters.
 *  - Must resolve to at least two labels (rejects `localhost`, `intranet`).
 *  - Leading / trailing dot or dash rejected; underscores rejected (RFC 1035 is
 *    the strict subset we accept).
 *  - Personal-email domains rejected (imported separately — this validator is
 *    syntax-only; the caller combines it with `isPersonalEmailDomain`).
 */

import { isPersonalEmailDomain } from "./personal-email-domains";

/**
 * Strict RFC 1035 / 1123 hostname regex restricted to 2+ labels.
 * Label: alnum, optional internal dashes, 1–63 chars.
 */
export const DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type TenantDomainError = "syntax" | "personal_email" | "idn_unsupported" | "too_long";

export function validateTenantDomain(
  input: string,
): { ok: true; domain: string } | { ok: false; reason: TenantDomainError } {
  const normalised = input.trim().toLowerCase();
  if (normalised.length === 0) return { ok: false, reason: "syntax" };
  if (normalised.length > 253) return { ok: false, reason: "too_long" };
  // Reject IDN / punycode proactively — enterprise tenants in scope use ASCII
  // domains; accepting `xn--…` would enable homograph spoofing (ADR-016).
  if (normalised.startsWith("xn--") || normalised.includes(".xn--")) {
    return { ok: false, reason: "idn_unsupported" };
  }
  if (!DOMAIN_PATTERN.test(normalised)) return { ok: false, reason: "syntax" };
  if (isPersonalEmailDomain(normalised)) return { ok: false, reason: "personal_email" };
  return { ok: true, domain: normalised };
}
