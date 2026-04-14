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

/** Generate a tax receipt PDF in memory and return the buffer */
export function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

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
  });
}
