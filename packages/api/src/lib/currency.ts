/**
 * Currency validation against the platform's enabled `currency_metadata`.
 *
 * Clients (public checkout + manual donation form) send lowercase ISO-4217
 * codes (`"gbp"`, `"usd"`). The route TypeBox schemas used to hard-code an
 * uppercase 3-literal union, so a lowercase or non-listed code either 400'd
 * (public checkout — manual-test finding #5) or was silently dropped and
 * defaulted to EUR (manual donation — finding #9). This helper is the single
 * case-insensitive gate: it normalises to the canonical UPPERCASE code and
 * confirms the currency is enabled, so we can accept EVERY Fixer-supported
 * currency (finding #11) instead of a hard-coded European subset.
 *
 * `currency_metadata` is platform-global (no `org_id`, no RLS) → systemDb.
 */

import { currencyMetadata } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { systemDb } from "./db.js";

const ISO_4217 = /^[A-Z]{3}$/;

/**
 * Resolve a client-supplied currency code to its canonical UPPERCASE form iff it
 * is enabled in `currency_metadata`. Returns null for absent / malformed /
 * unknown / disabled codes — the caller maps null to a field-scoped 422.
 */
export async function resolveEnabledCurrency(
  input: string | null | undefined,
): Promise<string | null> {
  if (!input) return null;
  const code = input.trim().toUpperCase();
  if (!ISO_4217.test(code)) return null;
  const [row] = await systemDb
    .select({ code: currencyMetadata.code })
    .from(currencyMetadata)
    .where(and(eq(currencyMetadata.code, code), eq(currencyMetadata.enabled, true)))
    .limit(1);
  return row ? code : null;
}
