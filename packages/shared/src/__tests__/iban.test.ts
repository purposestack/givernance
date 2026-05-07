/**
 * Unit tests for the IBAN / QRR / SCOR validators (Epic #318).
 *
 * Test vectors are the canonical examples from:
 *   - SIX IG QR-bill v2.4 Annex B (QRR mod-10 worked example)
 *   - ISO 11649 RF Creditor Reference reference doc (SCOR)
 *   - PostFinance + ECBS sample IBANs
 */

import { describe, expect, it } from "vitest";

import {
  classifyIban,
  getIbanCountry,
  isQrIban,
  isValidIban,
  isValidQrr,
  isValidScor,
} from "../validators/iban";

describe("isValidIban", () => {
  it("accepts a valid Swiss IBAN", () => {
    expect(isValidIban("CH9300762011623852957")).toBe(true);
  });

  it("accepts a valid Swiss QR-IBAN", () => {
    expect(isValidIban("CH4431999123000889012")).toBe(true);
  });

  it("tolerates whitespace and lowercase", () => {
    expect(isValidIban("ch93 0076 2011 6238 5295 7")).toBe(true);
  });

  it("rejects an IBAN with a wrong check digit", () => {
    expect(isValidIban("CH9300762011623852958")).toBe(false);
  });

  it("rejects an IBAN that's too short", () => {
    expect(isValidIban("CH93")).toBe(false);
  });

  it("rejects an IBAN with a non-alphanumeric character", () => {
    expect(isValidIban("CH93*0076*2011*6238*5295*7")).toBe(false);
  });

  it("rejects an IBAN with a malformed country prefix", () => {
    expect(isValidIban("1H9300762011623852957")).toBe(false);
  });
});

describe("getIbanCountry", () => {
  it("returns the 2-letter country prefix", () => {
    expect(getIbanCountry("CH9300762011623852957")).toBe("CH");
    expect(getIbanCountry("LI9300762011623852957")).toBe("LI");
  });

  it("uppercases the country code", () => {
    expect(getIbanCountry("ch9300762011623852957")).toBe("CH");
  });

  it("returns empty string for too-short input", () => {
    expect(getIbanCountry("C")).toBe("");
  });
});

describe("isQrIban", () => {
  it("accepts a CH IBAN with IID 31999 (boundary)", () => {
    expect(isQrIban("CH4431999123000889012")).toBe(true);
  });

  it("rejects a regular CH IBAN with IID outside 30000-31999", () => {
    expect(isQrIban("CH9300762011623852957")).toBe(false);
  });

  it("rejects a non-CH/LI IBAN even with a 30000-range IID", () => {
    // Synthetic French IBAN with 30000 IID — France does not have QR-IBANs.
    expect(isQrIban("FR0030000000000000000000")).toBe(false);
  });

  it("tolerates whitespace", () => {
    expect(isQrIban("CH44 3199 9123 0008 8901 2")).toBe(true);
  });

  it("rejects a too-short input", () => {
    expect(isQrIban("CH44")).toBe(false);
  });
});

describe("classifyIban", () => {
  it("classifies a QR-IBAN", () => {
    expect(classifyIban("CH4431999123000889012")).toBe("qr_iban");
  });

  it("classifies a regular IBAN", () => {
    expect(classifyIban("CH9300762011623852957")).toBe("iban");
  });

  it("rejects an invalid IBAN", () => {
    expect(classifyIban("CH9300762011623852958")).toBe("invalid");
  });

  it("rejects garbage input", () => {
    expect(classifyIban("not-an-iban")).toBe("invalid");
  });

  it("normalises whitespace before classifying", () => {
    expect(classifyIban("ch44 3199 9123 0008 8901 2")).toBe("qr_iban");
  });
});

describe("isValidQrr", () => {
  it("accepts the canonical 27-digit QRR example", () => {
    // IG QR-bill Annex B worked example: 21 00000 00003 13947 14300 09017
    expect(isValidQrr("210000000003139471430009017")).toBe(true);
  });

  it("rejects a QRR with an off-by-one check digit", () => {
    expect(isValidQrr("210000000003139471430009018")).toBe(false);
  });

  it("rejects a QRR that's the wrong length", () => {
    expect(isValidQrr("21000000000313947143000901")).toBe(false);
    expect(isValidQrr("2100000000031394714300090170")).toBe(false);
  });

  it("rejects a QRR containing non-digits", () => {
    expect(isValidQrr("21000000000313947143000901A")).toBe(false);
  });

  it("tolerates internal whitespace (printed-form input)", () => {
    expect(isValidQrr("21 00000 00003 13947 14300 09017")).toBe(true);
  });

  it("accepts the all-zeros 27-digit QRR (degenerate but valid)", () => {
    expect(isValidQrr("000000000000000000000000000")).toBe(true);
  });
});

describe("isValidScor", () => {
  it("accepts a valid SCOR (ISO 11649 sample)", () => {
    expect(isValidScor("RF18539007547034")).toBe(true);
  });

  it("rejects a SCOR with a wrong check digit", () => {
    expect(isValidScor("RF19539007547034")).toBe(false);
  });

  it("tolerates whitespace and lowercase", () => {
    expect(isValidScor("rf18 5390 0754 7034")).toBe(true);
  });

  it("rejects a SCOR longer than 25 chars", () => {
    expect(isValidScor("RF18539007547034ABCDEFGHIJKLMN")).toBe(false);
  });

  it("rejects a SCOR without the RF prefix", () => {
    expect(isValidScor("XX18539007547034")).toBe(false);
  });

  it("rejects an empty / too-short SCOR", () => {
    expect(isValidScor("")).toBe(false);
    expect(isValidScor("RF18")).toBe(false);
  });
});
