/**
 * IBAN, QRR, and SCOR validators (Epic #318).
 *
 * Pure functions — no Node-only deps so the web package can import
 * them for client-side feedback (ADR-013 type boundary). Inputs are
 * normalised (whitespace stripped, uppercased) before checksums run;
 * the API layer rejects malformed values at the boundary, but these
 * helpers are also called from the campaign-form and the bank-account
 * form to give the operator instant feedback.
 *
 * References:
 *   - ISO 13616 — IBAN structure + mod-97 checksum
 *   - ISO 11649 — RF Creditor Reference (SCOR), mod-97 with `RF00`
 *                 placeholder
 *   - SIX IG QR-bill v2.4 Annex B — QRR mod-10 recursive (Damm-style
 *                 lookup table)
 */

/** Strip whitespace and uppercase. Cheap normaliser used by every helper below. */
function normalise(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/**
 * Compute ISO 7064 mod-97 over an alphanumeric string. Letters map to
 * `A=10, B=11, ..., Z=35`. Runs the modulo per character (the *expanded*
 * decimal of a full IBAN would overflow Number.MAX_SAFE_INTEGER, but
 * each `remainder * 100 + digit` step stays well within safe-integer
 * bounds because `remainder < 97` and `digit ≤ 35`).
 */
function mod97(payload: string): number {
  let remainder = 0;
  for (const ch of payload) {
    const code = ch.charCodeAt(0);
    const digit =
      code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 90 ? code - 55 : Number.NaN;
    if (Number.isNaN(digit)) {
      return Number.NaN;
    }
    remainder = (remainder * (digit > 9 ? 100 : 10) + digit) % 97;
  }
  return remainder;
}

/**
 * Validate an IBAN. Strips whitespace, uppercases, checks length
 * (5-34 per ISO 13616), and verifies mod-97 = 1 over the rotated
 * payload. Country-specific length is NOT enforced here — that
 * responsibility lives in `getIbanCountry` + a country lookup at the
 * caller (we accept any ISO-13616-shaped IBAN as "valid format").
 */
export function isValidIban(input: string): boolean {
  const iban = normalise(input);
  if (iban.length < 5 || iban.length > 34) return false;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  const rotated = iban.slice(4) + iban.slice(0, 4);
  return mod97(rotated) === 1;
}

/** Return the 2-letter country code of an IBAN (after normalisation). Empty string when too short. */
export function getIbanCountry(input: string): string {
  const iban = normalise(input);
  return iban.length >= 2 ? iban.slice(0, 2) : "";
}

/**
 * QR-IBAN test: country ∈ {CH, LI} AND the IID (positions 5-9 in the
 * normalised IBAN, i.e. the 5-digit bank code that follows the 2-char
 * country + 2-char check digits) is in [30000, 31999]. The IID range
 * is reserved by SIX for QR-IBANs that pair with a 27-digit QRR.
 *
 * Returns false on any malformed input — callers should guard with
 * `isValidIban` first if they need to disambiguate.
 */
export function isQrIban(input: string): boolean {
  const iban = normalise(input);
  if (iban.length < 9) return false;
  const country = iban.slice(0, 2);
  if (country !== "CH" && country !== "LI") return false;
  const iidStr = iban.slice(4, 9);
  if (!/^\d{5}$/.test(iidStr)) return false;
  const iid = Number.parseInt(iidStr, 10);
  return iid >= 30000 && iid <= 31999;
}

/**
 * Three-way classification used by the bank-account form:
 *   - `qr_iban` — valid CH/LI IBAN with IID 30000-31999 (QRR-eligible)
 *   - `iban`    — valid IBAN, regular (SCOR-eligible)
 *   - `invalid` — anything else (mod-97 fails or shape wrong)
 */
export function classifyIban(input: string): "qr_iban" | "iban" | "invalid" {
  if (!isValidIban(input)) return "invalid";
  return isQrIban(input) ? "qr_iban" : "iban";
}

/**
 * QRR mod-10 recursive (Damm) check. Per IG QR-bill Annex B, a valid
 * QRR is exactly 27 digits where the last digit is the recursive
 * mod-10 checksum of the first 26, computed via the canonical
 * lookup table:
 *
 *     [ [0,9,4,6,8,2,7,1,3,5],
 *       [9,4,6,8,2,7,1,3,5,0],
 *       [4,6,8,2,7,1,3,5,0,9], ... ]
 *
 * It's commonly described as a single-row table where each next
 * carry is read from the row indexed by the current carry; the
 * implementation below uses that compact form.
 */
const QRR_CARRY_TABLE: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 9, 4, 6, 8, 2, 7, 1, 3, 5],
  [9, 4, 6, 8, 2, 7, 1, 3, 5, 0],
  [4, 6, 8, 2, 7, 1, 3, 5, 0, 9],
  [6, 8, 2, 7, 1, 3, 5, 0, 9, 4],
  [8, 2, 7, 1, 3, 5, 0, 9, 4, 6],
  [2, 7, 1, 3, 5, 0, 9, 4, 6, 8],
  [7, 1, 3, 5, 0, 9, 4, 6, 8, 2],
  [1, 3, 5, 0, 9, 4, 6, 8, 2, 7],
  [3, 5, 0, 9, 4, 6, 8, 2, 7, 1],
  [5, 0, 9, 4, 6, 8, 2, 7, 1, 3],
];

const QRR_CHECK_DIGIT_TABLE: ReadonlyArray<number> = [0, 9, 8, 7, 6, 5, 4, 3, 2, 1];

export function isValidQrr(input: string): boolean {
  const ref = input.replace(/\s+/g, "");
  if (!/^\d{27}$/.test(ref)) return false;
  let carry = 0;
  for (let i = 0; i < 26; i++) {
    const digit = ref.charCodeAt(i) - 48;
    const row = QRR_CARRY_TABLE[carry];
    if (row === undefined) return false;
    const next = row[digit];
    if (next === undefined) return false;
    carry = next;
  }
  const expected = QRR_CHECK_DIGIT_TABLE[carry];
  const actual = ref.charCodeAt(26) - 48;
  return expected === actual;
}

/**
 * Compute the QRR check digit for a 26-digit body using the Swiss
 * "Modulo 10 recursive" algorithm (IG QR-bill Annex B). Returns the
 * fully-formed 27-digit QRR string. Throws when the body is malformed
 * (anything other than 26 ASCII digits).
 *
 * Mirror of `isValidQrr` — exposing the inverse here lets the worker
 * mint references without re-implementing the carry table.
 */
export function computeQrr(body26: string): string {
  if (!/^\d{26}$/.test(body26)) {
    throw new Error(
      `computeQrr expected exactly 26 digits, got ${body26.length} chars: "${body26.slice(0, 32)}"`,
    );
  }
  let carry = 0;
  for (let i = 0; i < 26; i++) {
    const digit = body26.charCodeAt(i) - 48;
    const row = QRR_CARRY_TABLE[carry];
    if (row === undefined) {
      throw new Error("computeQrr: carry table miss (defensive — should not happen)");
    }
    const next = row[digit];
    if (next === undefined) {
      throw new Error("computeQrr: carry table digit-miss (defensive — should not happen)");
    }
    carry = next;
  }
  const check = QRR_CHECK_DIGIT_TABLE[carry];
  return `${body26}${check}`;
}

/** ISO 11649 reserves check digits 00, 01, and 99 — never emit-or-accept. */
const SCOR_RESERVED_CHECK_DIGITS = new Set(["00", "01", "99"]);

/**
 * SCOR (ISO 11649 RF Creditor Reference) check. Format:
 *   RF<2 check digits><up to 21 alphanumeric>
 * Total length 5-25 chars. Mod-97 = 1 over `<payload><RF><check>`
 * with letters mapped per ISO 7064. Reserved check digits (00, 01, 99)
 * are rejected per spec — they happen to validate by math but never
 * appear on legitimate references; accepting them masks adversarial
 * inputs.
 */
export function isValidScor(input: string): boolean {
  const ref = normalise(input);
  if (ref.length < 5 || ref.length > 25) return false;
  if (!/^RF[0-9]{2}[A-Z0-9]+$/.test(ref)) return false;
  if (SCOR_RESERVED_CHECK_DIGITS.has(ref.slice(2, 4))) return false;
  const rotated = ref.slice(4) + ref.slice(0, 4);
  return mod97(rotated) === 1;
}

/**
 * Compute a fully-formed ISO 11649 SCOR reference (`RF<check><payload>`)
 * from a 1-21 alphanumeric payload. Throws on a payload that doesn't
 * match the spec.
 *
 * Algorithm (ISO 11649 / ISO 7064 MOD 97-10): compute mod-97 over
 * `<payload>RF00` (letters substituted per the IBAN convention), the
 * check digits are `98 - remainder` left-padded to two characters.
 * Reserved check digits (00, 01, 99) are not produced by this routine —
 * a payload that yields one of those is rejected so the worker can
 * pick a different body (in practice unreachable for random payloads,
 * but caught defensively).
 */
export function computeScor(payload: string): string {
  const body = payload.toUpperCase();
  if (!/^[A-Z0-9]{1,21}$/.test(body)) {
    throw new Error(
      `computeScor expected a 1-21 alphanumeric payload, got ${payload.length} chars: "${payload.slice(0, 32)}"`,
    );
  }
  // mod-97 over "<payload>RF00": letters map A=10..Z=35, RF -> 27 15,
  // and "00" is the placeholder for the check digits we're solving for.
  const remainder = mod97(`${body}RF00`);
  if (Number.isNaN(remainder)) {
    throw new Error("computeScor: mod-97 produced NaN (defensive — should not happen)");
  }
  const check = 98 - remainder;
  if (SCOR_RESERVED_CHECK_DIGITS.has(check.toString().padStart(2, "0"))) {
    throw new Error(
      `computeScor: payload yields a reserved check digit (${check}); caller must pick a different body`,
    );
  }
  return `RF${check.toString().padStart(2, "0")}${body}`;
}
