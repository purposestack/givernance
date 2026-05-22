/**
 * Swiss QR-bill preview renderer — API-side lockstep duplicate of
 * `packages/worker/src/services/swiss-qr-bill.ts :: renderSwissQrBillPdf`
 * (Epic #318 PR #4 — extracted to its own file per ADR-027's
 * single-path policy).
 *
 * The preview the operator sees in the UI MUST match what the worker
 * actually produces in the bulk export — drift between the two would
 * re-introduce the "preview lies about the print" bug PR #4 was opened
 * to fix. Keeping the preview in its own file (rather than co-located
 * in `postal-pdf.ts`) makes the lockstep duplicate searchable by
 * filename and surfaces the contract via the module boundary.
 *
 * **1-page canonical (Epic #318 PR #4 follow-up).** Compressed appeal
 * content above the canonical IG QR-bill 105 mm strip on the SAME page.
 * Falls back to a 2-page layout automatically when the appeal content
 * overflows the 175 mm safe zone (long description, deep mission, etc.)
 * — mirrors the worker's behaviour exactly.
 *
 * `swissqrbill` v4 is Node-only (it composes onto a PDFKit document);
 * same constraint as PDFKit itself, so this lives in the API rather
 * than in `@givernance/shared` (ADR-013).
 *
 * Lockstep with `packages/worker/src/services/swiss-qr-bill.ts`.
 */

import type { Locale } from "@givernance/shared/i18n";
import {
  APPEAL_MAX_Y_PT,
  copyForLocale,
  localeToQrBillLanguage,
  MM_TO_PT,
} from "@givernance/shared/postal-print-layout";
import PDFDocument from "pdfkit";
import { SwissQRBill } from "swissqrbill/pdf";
import type { PostalLetterRecipient, PostalLetterRenderInput } from "./postal-pdf.js";

// Layout constants — mirror of the canonical `postal-pdf.ts` values
// (kept private to this module so a future change to the page geometry
// over there doesn't silently desync the preview without compile-time
// signal). The values themselves are derived from the shared `MM_TO_PT`
// in `@givernance/shared/postal-print-layout` so a drift in the unit
// factor is impossible.
const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 width in points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const ADDRESS_BLOCK_X = 110 * MM_TO_PT;
const ADDRESS_BLOCK_WIDTH = 80 * MM_TO_PT;

/**
 * Truthy when the recipient has the minimum address fields needed to fit
 * a French C5 window envelope. Lockstep with the same predicate in
 * `postal-pdf.ts`.
 */
function hasWindowEnvelopeAddress(recipient: PostalLetterRecipient | null): boolean {
  if (!recipient) return false;
  return Boolean(
    recipient.addressLine1?.trim() && recipient.postalCode?.trim() && recipient.city?.trim(),
  );
}

/**
 * Bank-account holder data needed by the QR-bill renderer. Mirrors the
 * worker's `BankAccount` row shape, but local-only here so the API
 * doesn't have to import Drizzle table types into a PDF module.
 */
export interface SwissQrBillPreviewBankAccount {
  iban: string;
  holderName: string;
  holderStreet: string;
  holderBuildingNumber: string | null;
  holderPostalCode: string;
  holderTown: string;
  holderCountryCode: string;
  /** ISO 4217 alpha-3 settlement currency — open-ended after ADR-031 §2.4. */
  currency: string;
}

export interface SwissQrBillPreviewInput extends PostalLetterRenderInput {
  bankAccount: SwissQrBillPreviewBankAccount;
  /** Reference token the slip will print. Preview uses a never-registered fixture. */
  reference: string;
}

// PDF rendering is intrinsically a long linear sequence (letterhead →
// mission → logo → recipient → title → description → salutation → body
// → hint → reference → optional addPage → strip). Extracting helpers
// would just disperse the layout without clarifying it; the function
// reads top-to-bottom as the printed page does.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see comment above
export async function renderSwissQrBillPreviewToBuffer(
  input: SwissQrBillPreviewInput,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    autoFirstPage: false,
    info: {
      Title: `${input.organisationName} — ${input.campaignName} — QR-bill preview`,
      Author: input.organisationName,
      Subject: input.campaignName,
    },
  });

  // ── Page 1: compressed appeal-letter content. ───────────────────────
  doc.addPage({ size: "A4", margin: PAGE_MARGIN });

  const copy = copyForLocale(input.locale);

  if (input.preview) {
    doc
      .save()
      .fillColor("#b45309")
      .font("Helvetica-Oblique")
      .fontSize(8)
      .text(copy.previewWatermark, PAGE_MARGIN, 8 * MM_TO_PT, {
        align: "center",
        width: CONTENT_WIDTH,
      })
      .restore();
  }

  // Letterhead — 18pt (compressed vs the 22pt standard rail).
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(18);
  doc.text(input.organisationName, PAGE_MARGIN, 20 * MM_TO_PT, {
    align: "center",
    width: CONTENT_WIDTH,
  });
  if (input.organisationMission && input.organisationMission.trim().length > 0) {
    doc.moveDown(0.2);
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#475569");
    doc.text(input.organisationMission.trim(), {
      align: "center",
      width: CONTENT_WIDTH,
      lineGap: 0,
    });
  }

  // Logo + recipient — C5-window-aligned at y=50mm (vs 60mm standard).
  const LOGO_AND_ADDRESS_Y = 50 * MM_TO_PT;
  if (input.logoBuffer) {
    const LOGO_SIZE_PT = 25 * MM_TO_PT;
    doc.image(input.logoBuffer, PAGE_MARGIN, LOGO_AND_ADDRESS_Y, {
      fit: [LOGO_SIZE_PT, LOGO_SIZE_PT],
    });
  }
  if (hasWindowEnvelopeAddress(input.recipient) && input.recipient) {
    doc.save().fillColor("#0f172a").font("Helvetica").fontSize(10);
    const lines: string[] = [`${input.recipient.firstName} ${input.recipient.lastName}`];
    if (input.recipient.addressLine1) lines.push(input.recipient.addressLine1);
    if (input.recipient.addressLine2) lines.push(input.recipient.addressLine2);
    lines.push(`${input.recipient.postalCode ?? ""} ${input.recipient.city ?? ""}`.trim());
    doc.text(lines.join("\n"), ADDRESS_BLOCK_X, LOGO_AND_ADDRESS_Y, {
      width: ADDRESS_BLOCK_WIDTH,
      lineGap: 0,
      align: "left",
    });
    doc.restore();
  }

  // Appeal body — starts at y=85mm (vs 100mm standard); 13pt title, 10pt body.
  doc.x = PAGE_MARGIN;
  doc.y = 85 * MM_TO_PT;
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13);
  doc.text(input.campaignName, { align: "left" });
  doc.moveDown(0.4);

  const hasDescription = Boolean(input.campaignDescription?.trim());
  if (hasDescription && input.campaignDescription) {
    doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
    doc.text(input.campaignDescription.trim(), { align: "justify", lineGap: 1 });
    doc.moveDown(0.6);
  }

  doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
  if (input.recipient) {
    doc.text(copy.greetingNamed(input.recipient.firstName, input.recipient.lastName));
  } else {
    doc.text(copy.greetingDoorDrop);
  }
  doc.moveDown(0.5);

  if (hasDescription) {
    doc.text(
      input.recipient ? copy.thanksWithDescriptionNamed : copy.thanksWithDescriptionDoorDrop,
      { align: "justify", lineGap: 1 },
    );
  } else {
    doc.text(input.recipient ? copy.thanksFallbackNamed : copy.thanksFallbackDoorDrop, {
      align: "justify",
      lineGap: 1,
    });
  }
  doc.moveDown(0.4);

  // Predict whether the BVR strip will fit at y=192mm on this page or
  // need to overflow onto a 2nd page — same prediction logic + same
  // wording variants as the worker (lockstep). The hint paragraph is
  // written WITH the prediction so the donor reads "below" when the
  // strip is below and "on the next page" when it isn't.
  // The constants live in `@givernance/shared/postal-print-layout` so the
  // preview can never silently drift from the worker render.
  const QR_BILL_HINT_HEIGHT_PT = 30 * MM_TO_PT;
  const goesToNextPage = doc.y + QR_BILL_HINT_HEIGHT_PT > APPEAL_MAX_Y_PT;
  const hintText = goesToNextPage ? copy.payViaQrBillNextPage : copy.payViaQrBillSamePage;

  // Short pay-via-BVR hint + reference token (no framed panel — the BVR
  // strip rendered next IS the visual CTA).
  doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
  doc.text(hintText, { align: "justify", lineGap: 1 });
  doc.moveDown(0.3);
  doc.fillColor("#0f172a").font("Courier").fontSize(10);
  doc.text(copy.referenceLabel(input.reference), { align: "left" });

  // Honour the prediction. If predicted "next page", addPage so the
  // donor's reading matches the actual artefact.
  if (goesToNextPage) {
    doc.addPage({ size: "A4", margin: 0 });
  } else if (doc.y > APPEAL_MAX_Y_PT) {
    // Defense-in-depth (MAJOR-7 follow-up to PR #355): the prediction
    // above is conservative but can still misfire on unusually long
    // campaign descriptions — PDFKit's line-height + justification
    // produce a final `doc.y` that the predictor estimates from a
    // fixed-height heuristic. Pre-empt with a 2nd-page fallback so we
    // never overprint the BVR strip's quiet zone (IG QR-bill v2.4
    // §3.4 — the payment strip MUST remain unobstructed). The hint
    // text reads "scan below" (technically incorrect) but BVR
    // conformance trumps copy precision; lockstep with the worker.
    doc.addPage({ size: "A4", margin: 0 });
  }

  // ── BVR strip: same page when it fits, page 2 on auto-fallback. ─────
  // `language` drives the printed slip labels (Account, Reference,
  // Payable by, …). Lockstep with the worker — falls back to `FR`
  // (the MVP default) rather than swissqrbill v4's `DE` default so a
  // French appeal never ends up under a German payment strip.
  const qrBill = new SwissQRBill(
    {
      // `SwissQRBill` v4 types currency as "CHF" | "EUR". Swiss QR-bill
      // scope: the readiness gate rejects non-Swiss currencies before a
      // preview or export can be enqueued. Cast safe at runtime.
      currency: input.bankAccount.currency as "CHF" | "EUR",
      reference: input.reference,
      creditor: {
        account: input.bankAccount.iban,
        name: input.bankAccount.holderName,
        address: input.bankAccount.holderStreet,
        buildingNumber: input.bankAccount.holderBuildingNumber ?? undefined,
        zip: input.bankAccount.holderPostalCode,
        city: input.bankAccount.holderTown,
        country: input.bankAccount.holderCountryCode,
      },
      message: input.campaignName,
    },
    { language: localeToQrBillLanguage(input.locale as Locale | null | undefined) },
  );
  qrBill.attachTo(doc);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));
    doc.end();
  });
}
