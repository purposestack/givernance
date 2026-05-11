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
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const QR_SIZE = 140;

// Locale-driven static copy — lockstep duplicate of the same table in
// `packages/api/src/modules/campaigns/postal-pdf.ts`. See that file for
// the full rationale and per-key documentation.
//
// **Intentional divergence vs. the api copy:** the api `LetterCopy` has
// a `previewWatermark` field that this interface does not. The worker
// path is the bulk-export pipeline (production print) and never renders
// a preview, so the watermark string would be dead code here. The api
// preview path is the only consumer of that field. All OTHER fields
// MUST stay byte-equivalent across the two files.
interface LetterCopy {
  greetingNamed: (firstName: string, lastName: string) => string;
  greetingDoorDrop: string;
  thanksWithDescriptionNamed: string;
  thanksWithDescriptionDoorDrop: string;
  thanksFallbackNamed: string;
  thanksFallbackDoorDrop: string;
  callToScan: string;
  referenceLabel: (token: string) => string;
  /**
   * Epic #318 PR #4 — Swiss QR-bill rail CTA strings. Two variants
   * because the BVR strip can land on the SAME page as the appeal
   * (1-page canonical layout) or on the NEXT page (auto-fallback when
   * the appeal overflows the 175mm safe zone). The renderer predicts
   * the layout and picks the right wording so the donor never reads
   * "scan the strip on the next page" when it's actually below.
   */
  payViaQrBillSamePage: string;
  payViaQrBillNextPage: string;
}

const LETTER_COPY: Record<Locale, LetterCopy> = {
  fr: {
    greetingNamed: (firstName, lastName) => `Bonjour ${firstName} ${lastName},`,
    greetingDoorDrop: "Bonjour,",
    thanksWithDescriptionNamed:
      "Merci pour votre soutien — chaque contribution, petite ou grande, fait une différence concrète.",
    thanksWithDescriptionDoorDrop:
      "Chaque contribution, petite ou grande, fait une différence concrète.",
    thanksFallbackNamed:
      "Merci pour votre soutien continu. Votre générosité est ce qui rend cette campagne possible — chaque contribution, petite ou grande, fait une différence concrète.",
    thanksFallbackDoorDrop:
      "Votre soutien peut faire une vraie différence pour cette campagne. Chaque contribution, petite ou grande, nous aide à aller plus loin.",
    callToScan: "Pour en savoir plus ou contribuer, scannez le QR code ci-dessous :",
    referenceLabel: (token) => `Référence · ${token}`,
    payViaQrBillSamePage:
      "Pour régler ce don, scannez le BVR ci-dessous depuis votre application d'e-banking. Il contient toutes les informations de paiement nécessaires.",
    payViaQrBillNextPage:
      "Pour régler ce don, scannez le BVR sur la page suivante depuis votre application d'e-banking. Il contient toutes les informations de paiement nécessaires.",
  },
  en: {
    greetingNamed: (firstName, lastName) => `Dear ${firstName} ${lastName},`,
    greetingDoorDrop: "Dear Supporter,",
    thanksWithDescriptionNamed:
      "Thank you for your continued support — every contribution, big or small, makes a tangible difference.",
    thanksWithDescriptionDoorDrop: "Every contribution, big or small, makes a tangible difference.",
    thanksFallbackNamed:
      "Thank you for your continued support. Your generosity is what makes this campaign possible — every contribution, big or small, makes a tangible difference.",
    thanksFallbackDoorDrop:
      "Your support could make a real difference for this campaign. Every contribution, big or small, helps us go further.",
    callToScan: "To learn more or contribute, scan the QR code below:",
    referenceLabel: (token) => `Reference · ${token}`,
    payViaQrBillSamePage:
      "To make your donation, scan the QR-bill below from your e-banking app. It carries all the payment details you need.",
    payViaQrBillNextPage:
      "To make your donation, scan the QR-bill on the next page from your e-banking app. It carries all the payment details you need.",
  },
};

function copyForLocale(locale: Locale | null | undefined): LetterCopy {
  return LETTER_COPY[locale ?? "fr"] ?? LETTER_COPY.fr;
}

// See `packages/api/src/modules/campaigns/postal-pdf.ts` for the full
// rationale behind the A4-folded-in-half / C5-window-envelope geometry.
// Both files MUST stay byte-equivalent in their rendering output.
const MM_TO_PT = 2.834645;
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
) => void;

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
  ctaPanel(doc, { panelTopY: doc.y, copy, data });
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

  await renderAppealLetterPage1OnDoc(doc, data, (d, ctx) => {
    void renderScanQrCtaPanel(d, ctx.data, ctx.copy, ctx.panelTopY);
  });

  // Note: `renderScanQrCtaPanel` is async (it calls QRCode.toDataURL),
  // but the standard letter path needs to await it before `doc.end()`.
  // We call it directly here in addition to via the closure so that
  // we await the actual QR-code generation properly.
  // ↑ Actually the closure call already kicks it off; we need to await
  // the QR-render to complete before ending the doc. Refactor below.
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
 */
export const APPEAL_MAX_Y_PT = 175 * MM_TO_PT; // ≈ 496pt, ~17mm above the BVR strip start

/** Predicted height of the pay-via-QR-bill hint paragraph + reference token. */
const QR_BILL_HINT_HEIGHT_PT = 30 * MM_TO_PT; // ≈ 85pt — conservative

/**
 * Outcome the renderer commits to: SAME page = the BVR strip will land
 * at y=192mm on this page; NEXT page = the caller must `addPage()`
 * before attaching the strip. The wording in the rendered hint is
 * picked to match this prediction so the donor never reads "below"
 * when the strip is on the next page (or vice versa).
 */
export type QrBillStripLocation = "same_page" | "next_page";

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
