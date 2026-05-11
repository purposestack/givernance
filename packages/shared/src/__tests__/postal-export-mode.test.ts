/**
 * Unit tests for `resolvePostalExportMode` and its companions (Epic #318 PR #4).
 *
 * The whole point of this helper is to be the single source of truth shared
 * by the API readiness-gate evaluator and the web mode-summary panel. If the
 * 4×4 truth table here ever drifts, the "preview doesn't match generation"
 * bug is back.
 */

import { describe, expect, it } from "vitest";

import {
  modeEmitsAppealLetter,
  modeEmitsQrBill,
  modePdfCount,
  type PostalExportRunMode,
  resolvePostalExportMode,
} from "../postal-export-mode";

describe("resolvePostalExportMode — 4-input truth table", () => {
  it("hasBank=false, hasPage=true → standard (today's default)", () => {
    expect(resolvePostalExportMode({ hasBank: false, hasPage: true })).toBe("standard");
  });

  it("hasBank=true,  hasPage=false → qr_bill_only (Swiss-only flow)", () => {
    expect(resolvePostalExportMode({ hasBank: true, hasPage: false })).toBe("qr_bill_only");
  });

  it("hasBank=true,  hasPage=true → hybrid (Swiss superset of French)", () => {
    expect(resolvePostalExportMode({ hasBank: true, hasPage: true })).toBe("hybrid");
  });

  it("hasBank=false, hasPage=false → blocked (degenerate)", () => {
    expect(resolvePostalExportMode({ hasBank: false, hasPage: false })).toBe("blocked");
  });
});

describe("modeEmitsAppealLetter — appeal-letter PDF presence", () => {
  const cases: Array<[PostalExportRunMode, boolean]> = [
    ["standard", true],
    ["qr_bill_only", false],
    ["hybrid", true],
    ["blocked", false],
  ];
  for (const [mode, expected] of cases) {
    it(`${mode} → ${expected}`, () => {
      expect(modeEmitsAppealLetter(mode)).toBe(expected);
    });
  }
});

describe("modeEmitsQrBill — Swiss QR-bill PDF presence", () => {
  const cases: Array<[PostalExportRunMode, boolean]> = [
    ["standard", false],
    ["qr_bill_only", true],
    ["hybrid", true],
    ["blocked", false],
  ];
  for (const [mode, expected] of cases) {
    it(`${mode} → ${expected}`, () => {
      expect(modeEmitsQrBill(mode)).toBe(expected);
    });
  }
});

describe("modePdfCount — ZIP-level artefact count per recipient", () => {
  const cases: Array<[PostalExportRunMode, 0 | 1 | 2]> = [
    ["standard", 1],
    ["qr_bill_only", 1], // 2-page bundle in 1 PDF
    ["hybrid", 2], // appeal + sibling rich QR-bill
    ["blocked", 0],
  ];
  for (const [mode, expected] of cases) {
    it(`${mode} → ${expected}`, () => {
      expect(modePdfCount(mode)).toBe(expected);
    });
  }
});
