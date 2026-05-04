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

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const QR_SIZE = 140;

// See `packages/api/src/modules/campaigns/postal-pdf.ts` for the full
// rationale behind the window-envelope geometry. Both files MUST stay
// byte-equivalent in their rendering output.
const MM_TO_PT = 2.834645;
const ADDRESS_BLOCK_X = 20 * MM_TO_PT;
const ADDRESS_BLOCK_Y = 50 * MM_TO_PT;
const ADDRESS_BLOCK_WIDTH = 90 * MM_TO_PT;
const ADDRESS_BLOCK_HEIGHT = 35 * MM_TO_PT;
const CONTENT_TOP_AFTER_ADDRESS = ADDRESS_BLOCK_Y + ADDRESS_BLOCK_HEIGHT + 20;

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

  // ── Recipient block (window envelope, optional) ───────────────────────
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
    doc.x = PAGE_MARGIN;
    doc.y = CONTENT_TOP_AFTER_ADDRESS;
  }

  // ── Letterhead ────────────────────────────────────────────────────────
  doc.fillColor("#0f172a");
  doc.font("Helvetica-Bold").fontSize(22);
  doc.text(data.organisationName, { align: "center" });
  if (data.organisationMission && data.organisationMission.trim().length > 0) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569");
    doc.text(data.organisationMission.trim(), { align: "center" });
  }

  doc.moveDown(0.8);
  const ruleY = doc.y;
  doc
    .strokeColor("#e2e8f0")
    .lineWidth(0.6)
    .moveTo(PAGE_MARGIN, ruleY)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, ruleY)
    .stroke();
  doc.moveDown(1.4);

  // ── Campaign title ────────────────────────────────────────────────────
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(16);
  doc.text(data.campaignName, { align: "left" });
  doc.moveDown(1.2);

  // ── Salutation ────────────────────────────────────────────────────────
  doc.fillColor("#0f172a").font("Helvetica").fontSize(12);
  if (data.recipient) {
    doc.text(`Dear ${data.recipient.firstName} ${data.recipient.lastName},`);
  } else {
    doc.text("Dear Supporter,");
  }
  doc.moveDown(0.8);

  // ── Body ──────────────────────────────────────────────────────────────
  if (data.campaignDescription && data.campaignDescription.trim().length > 0) {
    doc.text(data.campaignDescription.trim(), { align: "justify", lineGap: 2 });
    doc.moveDown(0.8);
  }

  doc.text(
    data.recipient
      ? "Thank you for your continued support. Your generosity is what makes this campaign possible — every contribution, big or small, makes a tangible difference."
      : "Your support could make a real difference for this campaign. Every contribution, big or small, helps us go further.",
    { align: "justify", lineGap: 2 },
  );
  doc.moveDown(0.8);
  doc.text("To learn more or contribute, scan the QR code below:", {
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
    .text(`Reference · ${data.qrReference}`, {
      align: "center",
      width: CONTENT_WIDTH,
    });

  doc.end();
  return doc;
}
