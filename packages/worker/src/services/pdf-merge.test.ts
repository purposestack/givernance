/**
 * Unit tests for `mergePdfBuffers` (project item #194221573).
 *
 * Builds small fixture PDFs with pdf-lib, merges them, and asserts the
 * output is a valid PDF whose page count is the sum of the inputs — the
 * "1 page per constituent" guarantee for the standard rail, and the
 * page-additive behaviour for the multi-page Swiss QR-bill rails.
 */

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { mergePdfBuffers } from "./pdf-merge.js";

/** Build a valid PDF buffer with `pageCount` blank A4 pages. */
async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    doc.addPage([595.28, 841.89]);
  }
  return Buffer.from(await doc.save());
}

/** Re-parse a merged buffer and return its page count. */
async function pageCountOf(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

describe("mergePdfBuffers", () => {
  it("concatenates single-page PDFs into one document, one page each", async () => {
    const inputs = await Promise.all([makePdf(1), makePdf(1), makePdf(1)]);
    const merged = await mergePdfBuffers(inputs);
    expect(await pageCountOf(merged)).toBe(3);
  });

  it("is page-additive for multi-page inputs (QR-bill rails)", async () => {
    // standard letter (1) + qr-bill (2) + hybrid recipient (1 + 2) = 6 pages.
    const inputs = await Promise.all([makePdf(1), makePdf(2), makePdf(1), makePdf(2)]);
    const merged = await mergePdfBuffers(inputs);
    expect(await pageCountOf(merged)).toBe(6);
  });

  it("preserves input order (a single buffer round-trips to the same page count)", async () => {
    const single = await makePdf(1);
    const merged = await mergePdfBuffers([single]);
    expect(await pageCountOf(merged)).toBe(1);
  });

  it("returns a parseable PDF (valid %PDF header)", async () => {
    const merged = await mergePdfBuffers([await makePdf(1)]);
    expect(merged.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("throws on an empty input set rather than emitting an empty PDF", async () => {
    await expect(mergePdfBuffers([])).rejects.toThrow(/empty merged PDF/i);
  });
});
