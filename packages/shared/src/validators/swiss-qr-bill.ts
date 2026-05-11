/**
 * Pre-flight validators for Swiss QR-bill payloads (Epic #318).
 *
 * `validateSwissQrBillPayload` is the single entry point used by the
 * worker before mint and by the API readiness-gate evaluator before a
 * postal export is enqueued. It returns a structured result rather
 * than throwing — readiness gates surface every offending field at
 * once so the operator can fix them in one pass.
 *
 * Field caps mirror IG QR-bill v2.4 / v2.5 structured-address (S)
 * string limits (see `bank_accounts` column widths in migration 0044).
 * Combined address (K) is not supported — v2.5 makes S mandatory from
 * 2026-09-30 and we ship S-only by construction. The library that
 * renders the slip (`swissqrbill` v4) enforces the same caps; this
 * pre-check fails loud at the readiness-gate boundary so the operator
 * never sees a "render failed" error after clicking Generate ZIP.
 */

import { classifyIban, getIbanCountry } from "./iban";

export type SwissQrBillReferenceType = "qrr" | "scor";
export type SwissQrBillCurrency = "CHF" | "EUR";

/** IG QR-bill v2.4 §4.3.6: amount range 0.00 – 999,999,999.99 (in cents). */
const SWISS_QR_BILL_AMOUNT_MAX_CENTS = 99_999_999_999;

export interface SwissQrBillPayloadInput {
  iban: string;
  currency: SwissQrBillCurrency;
  referenceType: SwissQrBillReferenceType;
  /** 0 = donor fills the amount in their e-banking app (the standard Swiss UX). Optional; defaults to 0. */
  amountCents?: number | null;
  holder: {
    name: string;
    /** IG `StrtNm` — street name, ≤ 70 chars (S-shape only; K not modelled). */
    street: string;
    /** IG `BldgNb` — building / house number, ≤ 16 chars. Optional per spec. */
    buildingNumber?: string | null;
    /** IG `PstCd` — postal code, ≤ 16 chars. */
    postalCode: string;
    /** IG `TwnNm` — town / city, ≤ 35 chars. */
    town: string;
    /** ISO 3166-1 alpha-2; must be CH or LI for an IG QR-bill. */
    countryCode: string;
  };
}

/** One error per offending field — readiness gates render them as a list. */
export interface SwissQrBillValidationError {
  field:
    | "iban"
    | "currency"
    | "referenceType"
    | "amountCents"
    | "holder.name"
    | "holder.street"
    | "holder.buildingNumber"
    | "holder.postalCode"
    | "holder.town"
    | "holder.countryCode";
  code:
    | "iban_invalid"
    | "iban_country_unsupported"
    | "currency_invalid"
    | "currency_reference_mismatch"
    | "amount_out_of_range"
    | "address_too_long"
    | "country_code_invalid"
    | "required_field_empty";
  message: string;
}

export type SwissQrBillValidationResult =
  | { ok: true }
  | { ok: false; errors: SwissQrBillValidationError[] };

const HOLDER_CAPS = {
  "holder.name": 70,
  "holder.street": 70,
  "holder.buildingNumber": 16,
  "holder.postalCode": 16,
  "holder.town": 35,
} as const;

type CappedHolderField = keyof typeof HOLDER_CAPS;
type RequiredHolderField = Exclude<CappedHolderField, "holder.buildingNumber">;

const HOLDER_REQUIRED_LABEL: Record<RequiredHolderField, string> = {
  "holder.name": "Holder name",
  "holder.street": "Holder street",
  "holder.postalCode": "Holder postal code",
  "holder.town": "Holder town",
};

/** Check IBAN validity + country in {CH, LI}. Returns at most one error. */
function checkIban(iban: string): SwissQrBillValidationError | null {
  if (classifyIban(iban) === "invalid") {
    return {
      field: "iban",
      code: "iban_invalid",
      message: "IBAN failed mod-97 / format validation.",
    };
  }
  const country = getIbanCountry(iban);
  if (country !== "CH" && country !== "LI") {
    return {
      field: "iban",
      code: "iban_country_unsupported",
      message: `Swiss QR-bill requires a CH or LI IBAN (got ${country}).`,
    };
  }
  return null;
}

/** Currency runtime guard — defends against ingress paths that bypass TS narrowing. */
function checkCurrency(input: SwissQrBillPayloadInput): SwissQrBillValidationError | null {
  if (input.currency !== "CHF" && input.currency !== "EUR") {
    return {
      field: "currency",
      code: "currency_invalid",
      message: `Swiss QR-bill requires CHF or EUR (got ${String(input.currency)}).`,
    };
  }
  // EUR + QRR is illegal under IG QR-bill v2.4 (euroSIC discontinuation 2022-09-30).
  if (input.currency === "EUR" && input.referenceType === "qrr") {
    return {
      field: "currency",
      code: "currency_reference_mismatch",
      message: "EUR + QRR is illegal under IG QR-bill v2.4 — switch the reference type to SCOR.",
    };
  }
  return null;
}

/** IG QR-bill v2.4 §4.3.6: amount must be 0.00 – 999,999,999.99. */
function checkAmount(input: SwissQrBillPayloadInput): SwissQrBillValidationError | null {
  const amount = input.amountCents ?? 0;
  if (!Number.isInteger(amount) || amount < 0 || amount > SWISS_QR_BILL_AMOUNT_MAX_CENTS) {
    return {
      field: "amountCents",
      code: "amount_out_of_range",
      message: `Amount must be 0–${SWISS_QR_BILL_AMOUNT_MAX_CENTS} cents (IG QR-bill v2.4 §4.3.6).`,
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
  field: "holder.buildingNumber",
  value: string | null | undefined,
): SwissQrBillValidationError | null {
  if (value == null) return null;
  const cap = HOLDER_CAPS[field];
  if (value.length > cap) {
    return {
      field,
      code: "address_too_long",
      message: `Holder building number exceeds ${cap} chars (got ${value.length}).`,
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
    checkCurrency(input),
    checkAmount(input),
    checkRequiredAndCap("holder.name", holder.name),
    checkRequiredAndCap("holder.street", holder.street),
    checkOptionalCap("holder.buildingNumber", holder.buildingNumber),
    checkRequiredAndCap("holder.postalCode", holder.postalCode),
    checkRequiredAndCap("holder.town", holder.town),
    checkCountryCode(holder.countryCode),
  ];
  const errors = candidates.filter((e): e is SwissQrBillValidationError => e !== null);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
