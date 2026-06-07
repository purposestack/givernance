/**
 * PDF concatenation helper — worker-only (project item #194221573,
 * "Export PDF unique multi-pages").
 *
 * The postal-export processor renders each recipient's artefact to a
 * self-contained PDF `Buffer` (the appeal letter via
 * `createCampaignLetterPdfStream`, and/or the Swiss QR-bill via
 * `renderSwissQrBillPdf`). For `format='zip'` those buffers are streamed
 * into `archiver`. For `format='merged_pdf'` they're concatenated here into
 * one multi-page document so the operator can print the whole batch in a
 * single job.
 *
 * Kept OUT of `campaign-pdf.ts` on purpose: that file is a byte-equivalent
 * lockstep duplicate of the API's `postal-pdf.ts`, and this merge step has
 * no preview counterpart on the API side. Co-locating it would muddy that
 * lockstep contract.
 *
 * Memory note: pdf-lib builds the whole output document in memory before
 * `save()` — there is no page-by-page streaming. The caller bounds the
 * input set via `MERGED_PDF_MAX_RECIPIENTS` (enforced at the API gate) so
 * the peak heap stays predictable.
 */

import { PDFDocument } from "pdf-lib";

/**
 * Concatenate the supplied PDF buffers, in order, into a single PDF.
 * Every page of every input document is copied across, so a 1-page
 * appeal letter contributes 1 page and a 2-page Swiss QR-bill PDF
 * contributes 2 — the merged document's page count is the sum.
 *
 * Throws if `buffers` is empty (an empty merged PDF is never a valid
 * export artefact — the processor guards recipient count upstream, so
 * this is a defensive invariant, not an expected path).
 */
export async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  if (buffers.length === 0) {
    throw new Error("mergePdfBuffers: refusing to build an empty merged PDF (zero input buffers)");
  }

  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    // `ignoreEncryption` keeps a single password-protected upstream PDF
    // (none of ours are today, but swissqrbill / future renderers could
    // change) from hard-failing the whole batch.
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }

  const bytes = await merged.save();
  return Buffer.from(bytes);
}
