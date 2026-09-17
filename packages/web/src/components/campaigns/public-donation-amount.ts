/**
 * Donor-typed amount → integer cents (issue #615).
 *
 * The amount field is a `type="text" inputMode="decimal"` input rather than
 * `type="number"`: a number input silently changes the amount on mouse-wheel
 * scroll, and reports an EMPTY value for "12,50" (the decimal comma most of
 * our EU donors type) while still showing the text. Parsing is therefore
 * ours, and strict — anything that isn't plain digits with an optional
 * 1–2 digit decimal part is rejected rather than guessed at ("1e3", "-1",
 * "1 000" never silently become a charge).
 *
 * Bounds mirror the API contract — `DonateBody.amountCents` in
 * `packages/api/src/modules/public/routes.ts` (`minimum: 100`,
 * `maximum: 1000000`). Keep the two in lockstep: a looser client bound
 * surfaces as a raw API validation error instead of a field message.
 */
export const PUBLIC_DONATION_MIN_CENTS = 100;
export const PUBLIC_DONATION_MAX_CENTS = 1_000_000;

const AMOUNT_PATTERN = /^\d+([.,]\d{1,2})?$/;

export type DonationAmountError = "required" | "invalid" | "belowMin" | "aboveMax";

export type ParsedDonationAmount =
  | { ok: true; cents: number }
  | { ok: false; error: DonationAmountError };

export function parseDonationAmount(raw: string): ParsedDonationAmount {
  const value = raw.trim();
  if (!value) return { ok: false, error: "required" };
  if (!AMOUNT_PATTERN.test(value)) return { ok: false, error: "invalid" };

  // Integer arithmetic on the two halves — `Number("12.35") * 100` is
  // 1234.9999999999998 and we are not rounding money through a float.
  const [whole = "0", fraction = ""] = value.replace(",", ".").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));

  if (cents < PUBLIC_DONATION_MIN_CENTS) return { ok: false, error: "belowMin" };
  if (cents > PUBLIC_DONATION_MAX_CENTS) return { ok: false, error: "aboveMax" };
  return { ok: true, cents };
}
