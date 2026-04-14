/** PDF generation service — renders EU tax receipt PDFs using PDFKit */

import PDFDocument from "pdfkit";

export interface ReceiptData {
  receiptNumber: string;
  orgId: string;
  donorName: string;
  donorEmail: string | null;
  amountCents: number;
  currency: string;
  donatedAt: Date;
  fiscalYear: number;
}

/**
 * Create a tax receipt PDF as a readable PDFKit stream.
 * The caller is responsible for piping this to S3 (or buffering if needed).
 */
export function createReceiptPdfStream(data: ReceiptData): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  const amount = (data.amountCents / 100).toFixed(2);
  const dateStr = data.donatedAt.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Header
  doc.fontSize(24).text("Tax Receipt", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Receipt Number: ${data.receiptNumber}`, { align: "center" });
  doc.moveDown(2);

  // Organization
  doc.fontSize(14).text("Organization", { underline: true });
  doc.fontSize(12).text(`Organization ID: ${data.orgId}`);
  doc.moveDown(1.5);

  // Donor
  doc.fontSize(14).text("Donor Information", { underline: true });
  doc.fontSize(12).text(`Name: ${data.donorName}`);
  if (data.donorEmail) {
    doc.text(`Email: ${data.donorEmail}`);
  }
  doc.moveDown(1.5);

  // Donation
  doc.fontSize(14).text("Donation Details", { underline: true });
  doc.fontSize(12).text(`Amount: ${amount} ${data.currency}`);
  doc.text(`Date: ${dateStr}`);
  doc.text(`Fiscal Year: ${data.fiscalYear}`);
  doc.moveDown(2);

  // Footer
  doc
    .fontSize(10)
    .text(
      "This receipt is issued for tax deduction purposes in accordance with applicable EU regulations.",
      { align: "center" },
    );

  doc.end();
  return doc;
}
