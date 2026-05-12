/**
 * Unit tests for the postal-letter PDF renderer (Epic #274 + Epic #318 PR #4).
 *
 * **Regression coverage for the PR #355 BLOCKER (B1)**: the standard-rail
 * letter must NOT seal its PDF stream before the donor-facing scan-QR
 * raster has been embedded. The previous implementation fire-and-forgot
 * `renderScanQrCtaPanel` via `void` inside `renderAppealLetterPage1OnDoc`,
 * then immediately called `doc.end()`. Because `QRCode.toDataURL` is
 * async, the QR image was NEVER drawn on the resulting PDF — every
 * standard / hybrid postal export shipped letters with an empty CTA
 * panel and no tracking code.
 *
 * This file asserts the awaited path completes cleanly and that the
 * resulting PDF carries an embedded image (the QR raster). Sibling
 * file `swiss-qr-bill.ts` follows the same compressed-appeal renderer
 * path and is covered by its own tests upstream.
 */

import { describe, expect, it } from "vitest";
import { type CampaignLetterData, createCampaignLetterPdfStream } from "./campaign-pdf.js";

/** Drain a PDFKit stream into a Buffer for byte-level assertions. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const FIXTURE_DATA: CampaignLetterData = {
  organisationName: "Test NGO",
  organisationMission: "We test things.",
  campaignName: "Spring appeal 2026",
  campaignDescription: "Help us print things in tests.",
  qrPayload: "https://example.org/p/00000000-0000-0000-0000-000000000001?qr=tok",
  qrReference: "test-qr-token",
  recipient: {
    firstName: "Jean",
    lastName: "Dupont",
    email: "jean.dupont@example.org",
    addressLine1: "12 rue de la République",
    addressLine2: null,
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
  },
  locale: "fr",
};

describe("createCampaignLetterPdfStream — B1 regression", () => {
  it("awaits the async scan-QR render before sealing the PDF stream", async () => {
    // The bug we're guarding against: `void renderScanQrCtaPanel(...)` would
    // resolve `createCampaignLetterPdfStream` immediately, then `doc.end()`
    // would race the still-pending `QRCode.toDataURL` and ship a PDF without
    // the QR. With the fix the function awaits the panel renderer; the
    // returned PDF reaches `end` only after the QR image has been embedded.
    const stream = await createCampaignLetterPdfStream(FIXTURE_DATA);
    const buffer = await streamToBuffer(stream);

    // PDF magic header — proves the stream sealed cleanly.
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");

    // PDFKit embeds the QR PNG as a `/Subtype /Image` object. The previous
    // buggy code path produced a PDF with NO image object (the QR closure
    // had not yet finished when the stream was sealed). Asserting the
    // presence of `/Subtype /Image` is the most direct byte-level proof
    // that the awaited path completed.
    const haystack = buffer.toString("latin1");
    expect(haystack).toContain("/Subtype /Image");
  });

  it("renders cleanly for a door-drop letter (no recipient block, still embeds the QR)", async () => {
    const stream = await createCampaignLetterPdfStream({
      ...FIXTURE_DATA,
      recipient: null,
    });
    const buffer = await streamToBuffer(stream);

    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    const haystack = buffer.toString("latin1");
    expect(haystack).toContain("/Subtype /Image");
  });
});
