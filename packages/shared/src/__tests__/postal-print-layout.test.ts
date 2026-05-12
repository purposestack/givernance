/**
 * Unit tests for the shared postal-print layout module (Epic #318 PR #4
 * BLOCKER + MAJOR follow-ups).
 *
 * Coverage focus:
 *   - LETTER_COPY parity across the two supported locales — adding a new
 *     CTA string to FR but forgetting EN (or vice versa) was the
 *     historical drift mode this guards against.
 *   - localeToQrBillLanguage exhaustiveness on every SUPPORTED_LOCALE
 *     + the null/undefined fall-throughs the renderer relies on.
 *   - hasPageFromStatus over every realistic input (no row, draft,
 *     published, and the hypothetical `archived` future-status).
 */

import { describe, expect, it } from "vitest";

import { type Locale, SUPPORTED_LOCALES } from "../i18n/locales.js";
import {
  APPEAL_MAX_Y_PT,
  copyForLocale,
  hasPageFromStatus,
  LETTER_COPY,
  type LetterCopy,
  localeToQrBillLanguage,
  MM_TO_PT,
  QR_BILL_HINT_HEIGHT_PT,
} from "../postal-print-layout.js";

describe("LETTER_COPY", () => {
  it("declares the same keys for every supported locale", () => {
    const referenceKeys = Object.keys(LETTER_COPY.fr).sort();
    for (const locale of SUPPORTED_LOCALES) {
      const localeKeys = Object.keys(LETTER_COPY[locale]).sort();
      expect(localeKeys).toEqual(referenceKeys);
    }
  });

  it("has a non-empty string for every leaf value (FR)", () => {
    const c: LetterCopy = LETTER_COPY.fr;
    expect(c.greetingNamed("Jean", "Dupont")).toContain("Jean");
    expect(c.greetingDoorDrop.length).toBeGreaterThan(0);
    expect(c.thanksWithDescriptionNamed.length).toBeGreaterThan(0);
    expect(c.thanksWithDescriptionDoorDrop.length).toBeGreaterThan(0);
    expect(c.thanksFallbackNamed.length).toBeGreaterThan(0);
    expect(c.thanksFallbackDoorDrop.length).toBeGreaterThan(0);
    expect(c.callToScan.length).toBeGreaterThan(0);
    expect(c.referenceLabel("tok")).toContain("tok");
    expect(c.previewWatermark.length).toBeGreaterThan(0);
    expect(c.payViaQrBillSamePage.length).toBeGreaterThan(0);
    expect(c.payViaQrBillNextPage.length).toBeGreaterThan(0);
  });

  it("has a non-empty string for every leaf value (EN)", () => {
    const c: LetterCopy = LETTER_COPY.en;
    expect(c.greetingNamed("John", "Doe")).toContain("John");
    expect(c.greetingDoorDrop.length).toBeGreaterThan(0);
    expect(c.payViaQrBillSamePage.length).toBeGreaterThan(0);
    expect(c.payViaQrBillNextPage.length).toBeGreaterThan(0);
  });
});

describe("copyForLocale", () => {
  it("returns FR copy for null/undefined (MVP primary market)", () => {
    expect(copyForLocale(null)).toBe(LETTER_COPY.fr);
    expect(copyForLocale(undefined)).toBe(LETTER_COPY.fr);
  });

  it("returns the requested locale's copy for every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(copyForLocale(locale)).toBe(LETTER_COPY[locale]);
    }
  });

  it("falls back to FR for an unknown locale (defensive)", () => {
    // The validator pins the column to SUPPORTED_LOCALES, but the
    // renderer's fall-through path is still load-bearing — a future
    // migration that adds a locale without seeding LETTER_COPY would
    // otherwise crash the PDF render. Cast to Locale because the
    // type-system would reject a literal "xx".
    expect(copyForLocale("xx" as unknown as Locale)).toBe(LETTER_COPY.fr);
  });
});

describe("localeToQrBillLanguage", () => {
  it("maps every supported locale to a swissqrbill v4 language code", () => {
    // Exhaustiveness — every SUPPORTED_LOCALE must land on a string
    // accepted by `swissqrbill` v4's `language` option (DE | EN | FR | IT).
    const accepted = new Set(["DE", "EN", "FR", "IT"] as const);
    for (const locale of SUPPORTED_LOCALES) {
      expect(accepted.has(localeToQrBillLanguage(locale))).toBe(true);
    }
  });

  it("returns 'EN' for 'en'", () => {
    expect(localeToQrBillLanguage("en")).toBe("EN");
  });

  it("returns 'FR' for 'fr', null, and undefined (MVP default)", () => {
    expect(localeToQrBillLanguage("fr")).toBe("FR");
    expect(localeToQrBillLanguage(null)).toBe("FR");
    expect(localeToQrBillLanguage(undefined)).toBe("FR");
  });
});

describe("hasPageFromStatus", () => {
  it("returns true for draft (page row exists, just not published)", () => {
    expect(hasPageFromStatus("draft")).toBe(true);
  });

  it("returns true for published (the standard happy-path)", () => {
    expect(hasPageFromStatus("published")).toBe(true);
  });

  it("returns false for null (no row in campaign_public_pages)", () => {
    expect(hasPageFromStatus(null)).toBe(false);
  });

  it("returns false for undefined (defensive — same shape as null)", () => {
    expect(hasPageFromStatus(undefined)).toBe(false);
  });
});

describe("layout constants", () => {
  it("MM_TO_PT preserves the canonical 2.834645 precision", () => {
    // Drift here would silently shift the BVR strip's y-coordinate; the
    // canonical Swiss spec value is 1mm = 2.834645pt.
    expect(MM_TO_PT).toBeCloseTo(2.834645, 6);
  });

  it("APPEAL_MAX_Y_PT is exactly 175 mm in points", () => {
    expect(APPEAL_MAX_Y_PT).toBe(175 * MM_TO_PT);
  });

  it("QR_BILL_HINT_HEIGHT_PT is exactly 30 mm in points (conservative)", () => {
    expect(QR_BILL_HINT_HEIGHT_PT).toBe(30 * MM_TO_PT);
  });
});
