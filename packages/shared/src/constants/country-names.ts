/**
 * ISO 3166-1 alpha-2 → country name lookup for postal addressing.
 *
 * European postal standards (UPU S42, La Poste cross-border guides) require
 * the country name printed in full on international mail — never the ISO
 * alpha-2 code. A letter to Berlin with `"DE"` in the address block is
 * non-conformant and may be delayed by sorting offices.
 *
 * Two-locale table (FR / EN) — the renderer picks the variant matching the
 * sending tenant's `default_locale` so a French operator sees `Allemagne`
 * and an English operator sees `Germany`. Recipients in the destination
 * country read it well enough either way; the priority is being a
 * recognisable language string, not the ISO code.
 *
 * Coverage: the EU/EEA + the immediate non-EU European neighbourhood that
 * European NPOs routinely mail to (UK, Switzerland, Norway, Iceland,
 * Liechtenstein, Monaco, Andorra, San Marino, Vatican). Additional
 * countries can be added on demand without a schema change.
 *
 * Lookup is case-insensitive and tolerates surrounding whitespace; falls
 * back to the upper-cased ISO code itself when no localised name exists,
 * so a tenant mailing to (e.g.) `JP` still gets a non-empty country line —
 * with the ISO code as the safest legible fallback.
 */

import type { Locale } from "../i18n/locales";

type CountryNameMap = Record<string, string>;

const COUNTRY_NAMES: Record<Locale, CountryNameMap> = {
  fr: {
    AD: "Andorre",
    AT: "Autriche",
    BE: "Belgique",
    BG: "Bulgarie",
    CH: "Suisse",
    CY: "Chypre",
    CZ: "République tchèque",
    DE: "Allemagne",
    DK: "Danemark",
    EE: "Estonie",
    ES: "Espagne",
    FI: "Finlande",
    FR: "France",
    GB: "Royaume-Uni",
    GR: "Grèce",
    HR: "Croatie",
    HU: "Hongrie",
    IE: "Irlande",
    IS: "Islande",
    IT: "Italie",
    LI: "Liechtenstein",
    LT: "Lituanie",
    LU: "Luxembourg",
    LV: "Lettonie",
    MC: "Monaco",
    MT: "Malte",
    NL: "Pays-Bas",
    NO: "Norvège",
    PL: "Pologne",
    PT: "Portugal",
    RO: "Roumanie",
    SE: "Suède",
    SI: "Slovénie",
    SK: "Slovaquie",
    SM: "Saint-Marin",
    VA: "Vatican",
  },
  en: {
    AD: "Andorra",
    AT: "Austria",
    BE: "Belgium",
    BG: "Bulgaria",
    CH: "Switzerland",
    CY: "Cyprus",
    CZ: "Czech Republic",
    DE: "Germany",
    DK: "Denmark",
    EE: "Estonia",
    ES: "Spain",
    FI: "Finland",
    FR: "France",
    GB: "United Kingdom",
    GR: "Greece",
    HR: "Croatia",
    HU: "Hungary",
    IE: "Ireland",
    IS: "Iceland",
    IT: "Italy",
    LI: "Liechtenstein",
    LT: "Lithuania",
    LU: "Luxembourg",
    LV: "Latvia",
    MC: "Monaco",
    MT: "Malta",
    NL: "Netherlands",
    NO: "Norway",
    PL: "Poland",
    PT: "Portugal",
    RO: "Romania",
    SE: "Sweden",
    SI: "Slovenia",
    SK: "Slovakia",
    SM: "San Marino",
    VA: "Vatican City",
  },
};

/**
 * Resolve an ISO 3166-1 alpha-2 country code into a human-readable name in
 * the requested locale, with a graceful fallback to the upper-cased ISO
 * code when the country isn't in our table. Returns `null` when the input
 * is null/empty so callers can skip rendering the line entirely.
 */
export function resolveCountryName(
  countryCode: string | null | undefined,
  locale: Locale | null | undefined,
): string | null {
  if (!countryCode) return null;
  const code = countryCode.trim().toUpperCase();
  if (!code) return null;
  const table: Record<string, string> = COUNTRY_NAMES[locale ?? "fr"] ?? COUNTRY_NAMES.fr;
  return table[code] ?? code;
}
