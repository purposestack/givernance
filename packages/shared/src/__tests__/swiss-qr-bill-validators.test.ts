/**
 * Unit tests for `validateSwissQrBillPayload` (Epic #318).
 *
 * Covers the cross-field rules (currency × reference type × amount)
 * and the IG QR-bill v2.4 / v2.5 structured-address (S) holder caps.
 */

import { describe, expect, it } from "vitest";

import {
  type SwissQrBillPayloadInput,
  type SwissQrBillValidationError,
  validateSwissQrBillPayload,
} from "../validators/swiss-qr-bill";

const VALID_BASE: SwissQrBillPayloadInput = {
  iban: "CH4431999123000889012",
  currency: "CHF",
  referenceType: "qrr",
  amountCents: 0,
  holder: {
    name: "Association XYZ",
    street: "Rue de Lausanne",
    buildingNumber: "12",
    postalCode: "1003",
    town: "Lausanne",
    countryCode: "CH",
  },
};

function errorCodes(input: SwissQrBillPayloadInput): string[] {
  const result = validateSwissQrBillPayload(input);
  return result.ok ? [] : result.errors.map((e: SwissQrBillValidationError) => e.code);
}

describe("validateSwissQrBillPayload — currency × reference type", () => {
  it("CHF + QRR is allowed", () => {
    expect(
      validateSwissQrBillPayload({ ...VALID_BASE, currency: "CHF", referenceType: "qrr" }).ok,
    ).toBe(true);
  });

  it("CHF + SCOR is allowed", () => {
    expect(
      validateSwissQrBillPayload({
        ...VALID_BASE,
        iban: "CH9300762011623852957",
        currency: "CHF",
        referenceType: "scor",
      }).ok,
    ).toBe(true);
  });

  it("EUR + SCOR is allowed", () => {
    expect(
      validateSwissQrBillPayload({
        ...VALID_BASE,
        iban: "CH9300762011623852957",
        currency: "EUR",
        referenceType: "scor",
      }).ok,
    ).toBe(true);
  });

  it("EUR + QRR is rejected (illegal under IG v2.4)", () => {
    const codes = errorCodes({ ...VALID_BASE, currency: "EUR", referenceType: "qrr" });
    expect(codes).toContain("currency_reference_mismatch");
  });

  it("rejects an unknown currency (runtime guard against ingress bypass)", () => {
    // Force a value past the TS narrowing — simulates a JSON ingress path.
    const codes = errorCodes({
      ...VALID_BASE,
      currency: "USD" as unknown as SwissQrBillPayloadInput["currency"],
    });
    expect(codes).toContain("currency_invalid");
  });
});

describe("validateSwissQrBillPayload — amount bounds (IG v2.4 §4.3.6)", () => {
  it("accepts amount = 0 (donor fills the slip)", () => {
    expect(validateSwissQrBillPayload({ ...VALID_BASE, amountCents: 0 }).ok).toBe(true);
  });

  it("accepts amount at the upper bound (999,999,999.99 = 99_999_999_999 cents)", () => {
    expect(validateSwissQrBillPayload({ ...VALID_BASE, amountCents: 99_999_999_999 }).ok).toBe(
      true,
    );
  });

  it("rejects a negative amount", () => {
    const codes = errorCodes({ ...VALID_BASE, amountCents: -1 });
    expect(codes).toContain("amount_out_of_range");
  });

  it("rejects amount over the IG-bill cap", () => {
    const codes = errorCodes({ ...VALID_BASE, amountCents: 100_000_000_000 });
    expect(codes).toContain("amount_out_of_range");
  });

  it("rejects a non-integer amount", () => {
    const codes = errorCodes({ ...VALID_BASE, amountCents: 1.5 });
    expect(codes).toContain("amount_out_of_range");
  });

  it("treats missing amountCents as 0 (donor-fills default)", () => {
    expect(validateSwissQrBillPayload({ ...VALID_BASE, amountCents: undefined }).ok).toBe(true);
  });
});

describe("validateSwissQrBillPayload — IBAN", () => {
  it("rejects an invalid IBAN", () => {
    const codes = errorCodes({ ...VALID_BASE, iban: "CH9300762011623852958" });
    expect(codes).toContain("iban_invalid");
  });

  it("rejects a non-CH/LI IBAN even when mod-97 valid", () => {
    // FR7630006000011234567890189 is a canonical valid French IBAN.
    const codes = errorCodes({ ...VALID_BASE, iban: "FR7630006000011234567890189" });
    expect(codes).toContain("iban_country_unsupported");
  });

  it("accepts a Liechtenstein IBAN", () => {
    // LI21088100002324013AA is a canonical valid LI IBAN per the
    // ECBS / IBAN registry test vectors.
    const result = validateSwissQrBillPayload({
      ...VALID_BASE,
      iban: "LI21088100002324013AA",
      referenceType: "scor",
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateSwissQrBillPayload — holder S-address caps", () => {
  it("rejects a holder name over 70 chars", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, name: "A".repeat(71) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("accepts a holder name at exactly 70 chars (boundary)", () => {
    const result = validateSwissQrBillPayload({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, name: "A".repeat(70) },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a street over 70 chars (IG `StrtNm`)", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, street: "A".repeat(71) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("rejects a building number over 16 chars (IG `BldgNb`)", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, buildingNumber: "A".repeat(17) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("accepts buildingNumber = null (operator's address has no street number)", () => {
    expect(
      validateSwissQrBillPayload({
        ...VALID_BASE,
        holder: { ...VALID_BASE.holder, buildingNumber: null },
      }).ok,
    ).toBe(true);
  });

  it("rejects a postalCode over 16 chars", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, postalCode: "1".repeat(17) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("rejects a town over 35 chars (IG `TwnNm`)", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, town: "A".repeat(36) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("rejects a country code that's not exactly 2 chars", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, countryCode: "CHE" },
    });
    expect(codes).toContain("country_code_invalid");
  });

  it("rejects empty required fields", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: {
        ...VALID_BASE.holder,
        name: "",
        street: "",
        postalCode: "",
        town: "",
      },
    });
    expect(codes.filter((c) => c === "required_field_empty")).toHaveLength(4);
  });

  it("returns multiple errors at once (not just the first)", () => {
    const result = validateSwissQrBillPayload({
      ...VALID_BASE,
      currency: "EUR",
      referenceType: "qrr",
      holder: { ...VALID_BASE.holder, name: "A".repeat(71), town: "A".repeat(36) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
