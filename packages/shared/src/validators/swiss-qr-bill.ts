/**
 * Pre-flight validators for Swiss QR-bill payloads (Epic #318).
 *
 * `validateSwissQrBillPayload` is the single entry point used by the
 * worker before mint and by the API readiness-gate evaluator before a
 * postal export is enqueued. It returns a structured result rather
 * than throwing — readiness gates surface every offending field at
 * once so the operator can fix them in one pass.
 *
 * Field caps mirror IG QR-bill v2.4 string limits (see
 * `bank_accounts` column widths in migration 0044). The library that
 * renders the slip (`swissqrbill` v4) enforces the same caps; this
 * pre-check fails loud at the readiness-gate boundary so the operator
 * never sees a "render failed" error after clicking Generate ZIP.
 */

import { classifyIban, isValidIban } from "./iban";

export type SwissQrBillReferenceType = "qrr" | "scor";
export type SwissQrBillCurrency = "CHF" | "EUR";

export interface SwissQrBillPayloadInput {
  iban: string;
  currency: SwissQrBillCurrency;
  referenceType: SwissQrBillReferenceType;
  holder: {
    name: string;
    addressLine1: string;
    addressLine2?: string | null;
    postalCode: string;
    city: string;
    countryCode: string;
  };
}

/** One error per offending field — readiness gates render them as a list. */
export interface SwissQrBillValidationError {
  field:
    | "iban"
    | "currency"
    | "referenceType"
    | "holder.name"
    | "holder.addressLine1"
    | "holder.addressLine2"
    | "holder.postalCode"
    | "holder.city"
    | "holder.countryCode";
  code:
    | "iban_invalid"
    | "iban_country_unsupported"
    | "currency_reference_mismatch"
    | "address_too_long"
    | "country_code_invalid"
    | "required_field_empty";
  message: string;
}

export type SwissQrBillValidationResult =
  | { ok: true }
  | { ok: false; errors: SwissQrBillValidationError[] };

type RequiredHolderField =
  | "holder.name"
  | "holder.addressLine1"
  | "holder.postalCode"
  | "holder.city";
type CappedHolderField = RequiredHolderField | "holder.addressLine2";

const HOLDER_CAPS: Record<CappedHolderField, number> = {
  "holder.name": 70,
  "holder.addressLine1": 70,
  "holder.addressLine2": 16,
  "holder.postalCode": 16,
  "holder.city": 35,
};

const HOLDER_REQUIRED_LABEL: Record<RequiredHolderField, string> = {
  "holder.name": "Holder name",
  "holder.addressLine1": "Holder address line 1",
  "holder.postalCode": "Holder postal code",
  "holder.city": "Holder city",
};

/** Check IBAN validity + country in {CH, LI}. Returns at most one error. */
function checkIban(iban: string): SwissQrBillValidationError | null {
  if (classifyIban(iban) === "invalid" || !isValidIban(iban)) {
    return {
      field: "iban",
      code: "iban_invalid",
      message: "IBAN failed mod-97 / format validation.",
    };
  }
  const country = iban.replace(/\s+/g, "").toUpperCase().slice(0, 2);
  if (country !== "CH" && country !== "LI") {
    return {
      field: "iban",
      code: "iban_country_unsupported",
      message: `Swiss QR-bill requires a CH or LI IBAN (got ${country}).`,
    };
  }
  return null;
}

/** EUR + QRR is illegal under IG QR-bill v2.4 (euroSIC discontinuation). */
function checkCurrencyReferenceConsistency(
  input: SwissQrBillPayloadInput,
): SwissQrBillValidationError | null {
  if (input.currency === "EUR" && input.referenceType === "qrr") {
    return {
      field: "currency",
      code: "currency_reference_mismatch",
      message: "EUR + QRR is illegal under IG QR-bill v2.4 — switch the reference type to SCOR.",
    };
  }
  return null;
}

function checkRequiredAndCap(
  field: RequiredHolderField,
  value: string,
): SwissQrBillValidationError | null {
  if (value.length === 0) {
    return {
      field,
      code: "required_field_empty",
      message: `${HOLDER_REQUIRED_LABEL[field]} is required.`,
    };
  }
  const cap = HOLDER_CAPS[field];
  if (value.length > cap) {
    return {
      field,
      code: "address_too_long",
      message: `${HOLDER_REQUIRED_LABEL[field]} exceeds ${cap} chars (got ${value.length}).`,
    };
  }
  return null;
}

function checkOptionalCap(
  field: "holder.addressLine2",
  value: string | null | undefined,
): SwissQrBillValidationError | null {
  if (value == null) return null;
  const cap = HOLDER_CAPS[field];
  if (value.length > cap) {
    return {
      field,
      code: "address_too_long",
      message: `Holder address line 2 exceeds ${cap} chars (got ${value.length}).`,
    };
  }
  return null;
}

function checkCountryCode(value: string): SwissQrBillValidationError | null {
  if (value.length !== 2) {
    return {
      field: "holder.countryCode",
      code: "country_code_invalid",
      message: "Holder country code must be ISO 3166-1 alpha-2 (exactly 2 chars).",
    };
  }
  return null;
}

export function validateSwissQrBillPayload(
  input: SwissQrBillPayloadInput,
): SwissQrBillValidationResult {
  const { holder } = input;
  const candidates: Array<SwissQrBillValidationError | null> = [
    checkIban(input.iban),
    checkCurrencyReferenceConsistency(input),
    checkRequiredAndCap("holder.name", holder.name),
    checkRequiredAndCap("holder.addressLine1", holder.addressLine1),
    checkOptionalCap("holder.addressLine2", holder.addressLine2),
    checkRequiredAndCap("holder.postalCode", holder.postalCode),
    checkRequiredAndCap("holder.city", holder.city),
    checkCountryCode(holder.countryCode),
  ];
  const errors = candidates.filter((e): e is SwissQrBillValidationError => e !== null);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
