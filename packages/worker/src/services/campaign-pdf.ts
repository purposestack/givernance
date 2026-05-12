/**
 * Postal-letter PDF renderer — worker variant (Epic #274 + content-
 * enrichment follow-up).
 *
 * **Lockstep duplicate** of `packages/api/src/modules/campaigns/postal-pdf.ts`.
 * The two files MUST stay byte-equivalent in their rendering output —
 * the preview the operator sees in the UI MUST match what the worker
 * actually produces in the bulk export, otherwise we ship a "preview
 * lies about the print" bug.
 *
 * We keep two copies because:
 *   - `pdfkit` is a heavy Node-only dep and we don't want it in
 *     `packages/shared` (which is loaded by the web bundle too);
 *   - cross-package imports `@givernance/api` → `@givernance/worker`
 *     break the dependency direction (worker should never import api).
 *
 * If you change the layout here, change the API copy in lockstep.
 * A future refactor can extract this to a dedicated `packages/print`
 * package once we have a second renderer (receipts, statements).
 */

import { resolveCountryName } from "@givernance/shared/constants";
import type { Locale } from "@givernance/shared/i18n";
import {
  APPEAL_MAX_Y_PT,
  copyForLocale,
  type LetterCopy,
  MM_TO_PT,
  QR_BILL_HINT_HEIGHT_PT,
  type QrBillStripLocation,
} from "@givernance/shared/postal-print-layout";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

// Re-export `LetterCopy` so existing intra-package imports (if any future
// helper lands here) keep working without crossing the shared boundary.
// `LetterCopy` is intentionally re-exported as a type so this file remains
// the canonical worker-side entry point.
// Re-export the strip-location prediction type — worker callers in
// `swiss-qr-bill.ts` import it from here today; preserving the symbol
// keeps the change behaviour-preserving.
export type { LetterCopy, QrBillStripLocation };

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const QR_SIZE = 140;

// See `packages/api/src/modules/campaigns/postal-pdf.ts` for the full
// rationale behind the A4-folded-in-half / C5-window-envelope geometry.
// Both files MUST stay byte-equivalent in their rendering output.
// `MM_TO_PT` is imported from `@givernance/shared/postal-print-layout` so
// the API preview and the worker bulk render share the exact same value.
const ADDRESS_BLOCK_X = 110 * MM_TO_PT;
const ADDRESS_BLOCK_Y = 60 * MM_TO_PT;
const ADDRESS_BLOCK_WIDTH = 80 * MM_TO_PT;
/** Y-coordinate where the campaign content starts (just below address). */
const CONTENT_TOP = 100 * MM_TO_PT;

export interface CampaignLetterRecipient {
  firstName: string;
  lastName: string;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
}

export interface CampaignLetterData {
  organisationName: string;
  /**
   * Optional org-logo bitmap (Epic #286 — `pdf-letterhead` variant from
   * the branding pipeline, 360×360 PNG @ 300 DPI). When present,
   * rendered top-left at the same Y as the address block (60mm) so the
   * cover panel reads as a balanced two-column layout. When null the
   * layout is unchanged from pre-#286. **Lockstep** with the api copy.
   */
  logoBuffer?: Buffer | null;
  organisationMission: string | null;
  campaignName: string;
  campaignDescription: string | null;
  qrPayload: string;
  qrReference: string;
  recipient: CampaignLetterRecipient | null;
  /**
   * Tenant default locale (`tenants.default_locale`). Drives the static
   * copy of the letter (salutation, body, call-to-scan). Defaults to
   * `fr` when null/undefined — the MVP's primary market.
   */
  locale?: Locale | null;
}

function hasWindowEnvelopeAddress(recipient: CampaignLetterRecipient | null): boolean {
  if (!recipient) return false;
  return Boolean(
    recipient.addressLine1?.trim() && recipient.postalCode?.trim() && recipient.city?.trim(),
  );
}

/**
 * Render the recipient address block in the C5 envelope window zone.
 * Pulled out of `createCampaignLetterPdfStream` to keep that function
 * under the cognitive-complexity threshold; behaviour-preserving.
 */
function renderRecipientAddressBlock(
  doc: InstanceType<typeof PDFDocument>,
  recipient: NonNullable<CampaignLetterData["recipient"]>,
  locale: CampaignLetterData["locale"],
): void {
  doc.save().fillColor("#0f172a").font("Helvetica").fontSize(11);
  const lines: string[] = [`${recipient.firstName} ${recipient.lastName}`];
  if (recipient.addressLine1) lines.push(recipient.addressLine1);
  if (recipient.addressLine2) lines.push(recipient.addressLine2);
  lines.push(`${recipient.postalCode ?? ""} ${recipient.city ?? ""}`.trim());
  if (recipient.countryCode && recipient.countryCode.trim().toUpperCase() !== "FR") {
    // ISO → localised country name (UPU S42 cross-border requirement).
    const countryName = resolveCountryName(recipient.countryCode, locale);
    if (countryName) lines.push(countryName);
  }
  doc.text(lines.join("\n"), ADDRESS_BLOCK_X, ADDRESS_BLOCK_Y, {
    width: ADDRESS_BLOCK_WIDTH,
    lineGap: 1,
    align: "left",
  });
  doc.restore();
}

/**
 * Render the bottom CTA panel — the rectangular framed area that follows
 * the appeal-letter body. Mode-dependent (Epic #318 PR #4):
 *   - **Standard** rail (default): a QR code that the donor scans to
 *     reach `/p/:campaignId`. Same as the original Epic #274 design.
 *   - **Swiss QR-bill rail** (PR #4): a "Pay via QR-bill on the next
 *     page" text panel pointing at the BVR strip on page 2 — no
 *     scannable QR here because the donor pays the printed BVR from
 *     their e-banking app, not by scanning a URL.
 *
 * The panel renderer is passed in by the caller so the same page-1
 * rendering function (`renderAppealLetterPage1OnDoc`) can produce
 * either flavour without branching.
 */
export type AppealCtaPanelRenderer = (
  doc: InstanceType<typeof PDFDocument>,
  context: {
    /** Top Y coordinate the CTA panel must start at (current doc.y at call time). */
    panelTopY: number;
    /** Locale-resolved copy table for the doc. */
    copy: LetterCopy;
    /** Full data payload, useful for the panel to read the reference, etc. */
    data: CampaignLetterData;
  },
) => Promise<void>;

/**
 * Default CTA panel — the QR code that drives the donor to the public
 * donation page (Epic #274). Used by `createCampaignLetterPdfStream`
 * (standard rail) and as the page-1 CTA in **Hybrid** mode's appeal-
 * letter PDF.
 */
async function renderScanQrCtaPanel(
  doc: InstanceType<typeof PDFDocument>,
  data: CampaignLetterData,
  copy: LetterCopy,
  panelTopY: number,
): Promise<void> {
  const qrDataUrl = await QRCode.toDataURL(data.qrPayload, {
    width: 320,
    margin: 1,
    errorCorrectionLevel: "M",
  });
  // biome-ignore lint/style/noNonNullAssertion: data URI from QRCode.toDataURL always contains a comma separator
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1]!, "base64");

  const PANEL_HEIGHT = 200;
  const qrX = (PAGE_WIDTH - QR_SIZE) / 2;
  const qrY = panelTopY + 14;

  doc
    .roundedRect(PAGE_MARGIN, panelTopY, CONTENT_WIDTH, PANEL_HEIGHT, 12)
    .fillColor("#f8fafc")
    .fill();

  doc.image(qrBuffer, qrX, qrY, { width: QR_SIZE, height: QR_SIZE });

  const captionY = qrY + QR_SIZE + 10;
  doc
    .fillColor("#0f172a")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(data.qrPayload, PAGE_MARGIN, captionY, {
      align: "center",
      width: CONTENT_WIDTH,
      lineBreak: false,
    });
  doc
    .moveDown(0.4)
    .fillColor("#64748b")
    .font("Helvetica")
    .fontSize(8)
    .text(copy.referenceLabel(data.qrReference), {
      align: "center",
      width: CONTENT_WIDTH,
    });
}

/**
 * Render the appeal-letter content onto an already-instantiated PDFKit
 * document. Pulled out of `createCampaignLetterPdfStream` so the Swiss
 * QR-bill renderer can reuse the SAME body and only swap the CTA panel
 * (donor-facing scan QR vs "see QR-bill on next page" text). Lockstep
 * with `packages/api/src/modules/campaigns/postal-pdf.ts`.
 *
 * Caller owns the doc lifecycle — DO NOT call `doc.end()` here. The
 * caller (standard letter, QR-bill PDF) either ends the stream itself
 * or adds further pages first.
 */
async function renderAppealLetterPage1OnDoc(
  doc: InstanceType<typeof PDFDocument>,
  data: CampaignLetterData,
  ctaPanel: AppealCtaPanelRenderer,
): Promise<void> {
  // ── TOP HALF — COVER (visible through C5 window after fold) ──────────
  // Letterhead — org name
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(22);
  doc.text(data.organisationName, PAGE_MARGIN, 25 * MM_TO_PT, {
    align: "center",
    width: CONTENT_WIDTH,
  });

  // Mission — under org name
  if (data.organisationMission && data.organisationMission.trim().length > 0) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569");
    doc.text(data.organisationMission.trim(), {
      align: "center",
      width: CONTENT_WIDTH,
    });
  }

  // Logo top-left at the same Y as the address block (60mm).
  if (data.logoBuffer) {
    const LOGO_X = PAGE_MARGIN;
    const LOGO_Y = 60 * MM_TO_PT;
    const LOGO_SIZE_MM = 30;
    const LOGO_SIZE_PT = LOGO_SIZE_MM * MM_TO_PT;
    doc.image(data.logoBuffer, LOGO_X, LOGO_Y, {
      fit: [LOGO_SIZE_PT, LOGO_SIZE_PT],
    });
  }

  // Recipient address block — middle-right of top half (C5 window zone)
  if (hasWindowEnvelopeAddress(data.recipient) && data.recipient) {
    renderRecipientAddressBlock(doc, data.recipient, data.locale);
  }

  // ── APPEAL CONTENT (flows continuously from just below the address) ──
  doc.x = PAGE_MARGIN;
  doc.y = CONTENT_TOP;

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(16);
  doc.text(data.campaignName, { align: "left" });
  doc.moveDown(0.6);

  const hasDescription = Boolean(data.campaignDescription?.trim());
  if (hasDescription && data.campaignDescription) {
    doc.fillColor("#0f172a").font("Helvetica").fontSize(11);
    doc.text(data.campaignDescription.trim(), { align: "justify", lineGap: 2 });
    doc.moveDown(1.0);
  }

  const copy = copyForLocale(data.locale);

  doc.fillColor("#0f172a").font("Helvetica").fontSize(12);
  if (data.recipient) {
    doc.text(copy.greetingNamed(data.recipient.firstName, data.recipient.lastName));
  } else {
    doc.text(copy.greetingDoorDrop);
  }
  doc.moveDown(0.8);

  if (hasDescription) {
    doc.text(
      data.recipient ? copy.thanksWithDescriptionNamed : copy.thanksWithDescriptionDoorDrop,
      { align: "justify", lineGap: 2 },
    );
  } else {
    doc.text(data.recipient ? copy.thanksFallbackNamed : copy.thanksFallbackDoorDrop, {
      align: "justify",
      lineGap: 2,
    });
  }
  doc.moveDown(0.8);

  doc.text(copy.callToScan, { align: "justify", lineGap: 2 });
  doc.moveDown(0.8);

  // CTA panel — caller decides what goes here (scan QR vs see-qr-bill-next-page).
  // The panel renderer is async (the scan-QR variant awaits QRCode.toDataURL);
  // we MUST await it before returning so the caller can safely `doc.end()`
  // immediately afterwards without the QR-render racing the stream seal.
  await ctaPanel(doc, { panelTopY: doc.y, copy, data });
}

/**
 * Build a postal-letter PDFKit stream. Caller pipes it to S3 (or to an
 * `archiver.append`) and is responsible for awaiting the stream's `end`
 * before considering the upload complete.
 *
 * Page 1 is rendered via the shared `renderAppealLetterPage1OnDoc`
 * helper; the bottom CTA panel is the canonical donate-QR (Epic #274).
 * For the Swiss QR-bill variant see `createSwissQrBillLetterPdfStream`.
 */
export async function createCampaignLetterPdfStream(
  data: CampaignLetterData,
): Promise<InstanceType<typeof PDFDocument>> {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: {
      Title: `${data.organisationName} — ${data.campaignName}`,
      Author: data.organisationName,
      Subject: data.campaignName,
    },
  });

  // `renderScanQrCtaPanel` is async (it awaits `QRCode.toDataURL`). Pass it
  // through as an async callback so `renderAppealLetterPage1OnDoc` awaits
  // the QR raster before returning — otherwise `doc.end()` below would seal
  // the PDF stream before the QR image landed on the page, and every
  // standard / hybrid postal letter would ship WITHOUT the donor-facing
  // scan QR (silent regression; the PDF still validates, just empty CTA).
  await renderAppealLetterPage1OnDoc(doc, data, async (d, ctx) => {
    await renderScanQrCtaPanel(d, ctx.data, ctx.copy, ctx.panelTopY);
  });
  doc.end();
  return doc;
}

/**
 * Render the appeal-letter content in **compressed** form for the Swiss
 * QR-bill 1-page layout (Epic #318 PR #4 follow-up). Same letterhead +
 * C5-window-aligned recipient block as the standard letter, but with:
 *
 *   - smaller fonts (org name 18pt, title 13pt, body 10pt) so the body
 *     fits in the 192mm zone above the IG QR-bill payment strip
 *   - no bottom CTA panel (the BVR strip rendered below by the caller
 *     IS the call-to-pay; an explicit "see strip below" panel would be
 *     redundant)
 *   - description max-height — caller measures `doc.y` after this
 *     returns; if past `APPEAL_MAX_Y_PT` the caller falls back to a
 *     2-page layout (strip on its own page 2)
 *
 * Lockstep with `packages/api/src/modules/campaigns/postal-pdf.ts`.
 *
 * `APPEAL_MAX_Y_PT`, `QR_BILL_HINT_HEIGHT_PT`, and `QrBillStripLocation` all
 * live in `@givernance/shared/postal-print-layout` so the API preview and
 * the worker bulk render share the exact same threshold (drift here would
 * silently re-introduce the "preview lies about generation" bug).
 */
// Re-export for downstream callers that need to read the threshold or
// switch on the strip-location prediction. Kept here for symmetry with
// the historical worker-side surface.
export { APPEAL_MAX_Y_PT };

// PDF rendering is intrinsically a long linear sequence; extracting
// helpers would disperse the layout without clarifying it.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see comment above
export async function renderCompressedAppealForQrBill(
  doc: InstanceType<typeof PDFDocument>,
  data: CampaignLetterData,
): Promise<QrBillStripLocation> {
  // Letterhead — slightly smaller than the standard rail (22pt → 18pt).
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(18);
  doc.text(data.organisationName, PAGE_MARGIN, 20 * MM_TO_PT, {
    align: "center",
    width: CONTENT_WIDTH,
  });

  // Mission — single line, italic, smaller (10pt → 9pt).
  if (data.organisationMission && data.organisationMission.trim().length > 0) {
    doc.moveDown(0.2);
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#475569");
    doc.text(data.organisationMission.trim(), {
      align: "center",
      width: CONTENT_WIDTH,
      lineGap: 0,
    });
  }

  // Logo + recipient address — keep C5 window alignment so the envelope
  // fold still works. y=50mm instead of 60mm to claw back vertical space.
  const LOGO_AND_ADDRESS_Y = 50 * MM_TO_PT;
  if (data.logoBuffer) {
    const LOGO_SIZE_PT = 25 * MM_TO_PT;
    doc.image(data.logoBuffer, PAGE_MARGIN, LOGO_AND_ADDRESS_Y, {
      fit: [LOGO_SIZE_PT, LOGO_SIZE_PT],
    });
  }
  if (hasWindowEnvelopeAddress(data.recipient) && data.recipient) {
    doc.save().fillColor("#0f172a").font("Helvetica").fontSize(10);
    const lines: string[] = [`${data.recipient.firstName} ${data.recipient.lastName}`];
    if (data.recipient.addressLine1) lines.push(data.recipient.addressLine1);
    if (data.recipient.addressLine2) lines.push(data.recipient.addressLine2);
    lines.push(`${data.recipient.postalCode ?? ""} ${data.recipient.city ?? ""}`.trim());
    doc.text(lines.join("\n"), ADDRESS_BLOCK_X, LOGO_AND_ADDRESS_Y, {
      width: ADDRESS_BLOCK_WIDTH,
      lineGap: 0,
      align: "left",
    });
    doc.restore();
  }

  // Appeal body — starts at y=85mm (vs 100mm standard) for more vertical
  // headroom. Fonts: title 13pt (vs 16pt), description 10pt (vs 11pt).
  doc.x = PAGE_MARGIN;
  doc.y = 85 * MM_TO_PT;

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13);
  doc.text(data.campaignName, { align: "left" });
  doc.moveDown(0.4);

  const hasDescription = Boolean(data.campaignDescription?.trim());
  if (hasDescription && data.campaignDescription) {
    doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
    doc.text(data.campaignDescription.trim(), { align: "justify", lineGap: 1 });
    doc.moveDown(0.6);
  }

  const copy = copyForLocale(data.locale);

  doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
  if (data.recipient) {
    doc.text(copy.greetingNamed(data.recipient.firstName, data.recipient.lastName));
  } else {
    doc.text(copy.greetingDoorDrop);
  }
  doc.moveDown(0.5);

  if (hasDescription) {
    doc.text(
      data.recipient ? copy.thanksWithDescriptionNamed : copy.thanksWithDescriptionDoorDrop,
      { align: "justify", lineGap: 1 },
    );
  } else {
    doc.text(data.recipient ? copy.thanksFallbackNamed : copy.thanksFallbackDoorDrop, {
      align: "justify",
      lineGap: 1,
    });
  }
  doc.moveDown(0.4);

  // Predict whether the BVR strip will fit at y=192mm on this page or
  // need to overflow onto a 2nd page. The hint paragraph + reference
  // token are written WITH this prediction so the donor reads "below"
  // when the strip is below and "on the next page" when it isn't.
  const projectedAfterHint = doc.y + QR_BILL_HINT_HEIGHT_PT;
  const stripLocation: QrBillStripLocation =
    projectedAfterHint > APPEAL_MAX_Y_PT ? "next_page" : "same_page";
  const hintText =
    stripLocation === "same_page" ? copy.payViaQrBillSamePage : copy.payViaQrBillNextPage;

  // Short pay-via-BVR hint + reference token. No framed panel — the BVR
  // strip rendered next IS the visual CTA; a separate framed panel would
  // compete with it for attention.
  doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
  doc.text(hintText, { align: "justify", lineGap: 1 });
  doc.moveDown(0.3);
  doc.fillColor("#0f172a").font("Courier").fontSize(10);
  doc.text(copy.referenceLabel(data.qrReference), { align: "left" });

  return stripLocation;
}
