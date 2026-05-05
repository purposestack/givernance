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
interface LetterCopy {
  greetingNamed: (firstName: string, lastName: string) => string;
  greetingDoorDrop: string;
  thanksWithDescriptionNamed: string;
  thanksWithDescriptionDoorDrop: string;
  thanksFallbackNamed: string;
  thanksFallbackDoorDrop: string;
  callToScan: string;
  referenceLabel: (token: string) => string;
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
/** Y-coordinate where the bottom-half (appeal content) starts. */
const BOTTOM_HALF_TOP = 158 * MM_TO_PT;

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
 * Build a postal-letter PDFKit stream. Caller pipes it to S3 (or to an
 * `archiver.append`) and is responsible for awaiting the stream's `end`
 * before considering the upload complete.
 */
export async function createCampaignLetterPdfStream(
  data: CampaignLetterData,
): Promise<InstanceType<typeof PDFDocument>> {
  const qrDataUrl = await QRCode.toDataURL(data.qrPayload, {
    width: 320,
    margin: 1,
    errorCorrectionLevel: "M",
  });
  // biome-ignore lint/style/noNonNullAssertion: data URI from QRCode.toDataURL always contains a comma separator
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1]!, "base64");

  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: {
      Title: `${data.organisationName} — ${data.campaignName}`,
      Author: data.organisationName,
      Subject: data.campaignName,
    },
  });

  // ── TOP HALF — COVER (visible through C5 window after fold) ──────────
  // Lockstep with `packages/api/src/modules/campaigns/postal-pdf.ts` —
  // see that file for the full layout rationale (org letterhead + mission
  // at top, recipient block right-of-center middle of the top half so it
  // aligns with the C5 envelope window).

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

  // Recipient address block — middle-right of top half (C5 window zone)
  const renderAddressBlock = hasWindowEnvelopeAddress(data.recipient);
  if (renderAddressBlock && data.recipient) {
    doc.save().fillColor("#0f172a").font("Helvetica").fontSize(11);
    const lines: string[] = [`${data.recipient.firstName} ${data.recipient.lastName}`];
    if (data.recipient.addressLine1) lines.push(data.recipient.addressLine1);
    if (data.recipient.addressLine2) lines.push(data.recipient.addressLine2);
    lines.push(`${data.recipient.postalCode ?? ""} ${data.recipient.city ?? ""}`.trim());
    if (data.recipient.countryCode && data.recipient.countryCode.trim().toUpperCase() !== "FR") {
      lines.push(data.recipient.countryCode.trim().toUpperCase());
    }
    doc.text(lines.join("\n"), ADDRESS_BLOCK_X, ADDRESS_BLOCK_Y, {
      width: ADDRESS_BLOCK_WIDTH,
      lineGap: 1,
      align: "left",
    });
    doc.restore();
  }

  // ── BOTTOM HALF — APPEAL (visible after unfolding) ────────────────────
  doc.x = PAGE_MARGIN;
  doc.y = BOTTOM_HALF_TOP;

  // Campaign title
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(16);
  doc.text(data.campaignName, { align: "left" });
  doc.moveDown(0.6);

  // Campaign description — directly under the title (lockstep with api)
  const hasDescription = Boolean(data.campaignDescription?.trim());
  if (hasDescription && data.campaignDescription) {
    doc.fillColor("#0f172a").font("Helvetica").fontSize(11);
    doc.text(data.campaignDescription.trim(), { align: "justify", lineGap: 2 });
    doc.moveDown(1.0);
  }

  // ── Locale-driven static copy ─────────────────────────────────────────
  const copy = copyForLocale(data.locale);

  // Salutation
  doc.fillColor("#0f172a").font("Helvetica").fontSize(12);
  if (data.recipient) {
    doc.text(copy.greetingNamed(data.recipient.firstName, data.recipient.lastName));
  } else {
    doc.text(copy.greetingDoorDrop);
  }
  doc.moveDown(0.8);

  // Thanks paragraph (transition if description present, fallback otherwise)
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

  // Call to scan
  doc.text(copy.callToScan, {
    align: "justify",
    lineGap: 2,
  });
  doc.moveDown(0.8);

  // ── QR panel — flows inline after the body (Epic #274 follow-up). ────
  // See `packages/api/src/modules/campaigns/postal-pdf.ts` for the full
  // rationale; both renderers MUST keep this layout in lockstep.
  const PANEL_HEIGHT = 200;
  const panelTopY = doc.y;
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

  doc.end();
  return doc;
}
