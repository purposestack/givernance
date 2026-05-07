/**
 * Unit tests for `validateSwissQrBillPayload` (Epic #318).
 *
 * Covers the cross-field rules (currency × reference type) and the
 * IG QR-bill v2.4 holder-address caps.
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
  holder: {
    name: "Association XYZ",
    addressLine1: "Rue de Lausanne 12",
    addressLine2: null,
    postalCode: "1003",
    city: "Lausanne",
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
    // LI21088100002324013AA is a canonical valid LI IBAN.
    const result = validateSwissQrBillPayload({
      ...VALID_BASE,
      iban: "LI21088100002324013AA",
      referenceType: "scor",
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateSwissQrBillPayload — holder address caps", () => {
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

  it("rejects an addressLine1 over 70 chars", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, addressLine1: "A".repeat(71) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("rejects an addressLine2 over 16 chars", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, addressLine2: "A".repeat(17) },
    });
    expect(codes).toContain("address_too_long");
  });

  it("accepts addressLine2 = null", () => {
    expect(
      validateSwissQrBillPayload({
        ...VALID_BASE,
        holder: { ...VALID_BASE.holder, addressLine2: null },
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

  it("rejects a city over 35 chars", () => {
    const codes = errorCodes({
      ...VALID_BASE,
      holder: { ...VALID_BASE.holder, city: "A".repeat(36) },
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
        addressLine1: "",
        postalCode: "",
        city: "",
      },
    });
    expect(codes.filter((c) => c === "required_field_empty")).toHaveLength(4);
  });

  it("returns multiple errors at once (not just the first)", () => {
    const result = validateSwissQrBillPayload({
      ...VALID_BASE,
      currency: "EUR",
      referenceType: "qrr",
      holder: { ...VALID_BASE.holder, name: "A".repeat(71), city: "A".repeat(36) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
