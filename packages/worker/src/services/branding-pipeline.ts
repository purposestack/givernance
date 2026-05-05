/**
 * Branding image pipeline — Epic #286.
 *
 * Takes a sanitised original buffer + MIME and derives the four
 * canonical variants the rest of the app consumes:
 *
 *   - `sidebar`        128×128 WebP — left-rail collapsed nav badge.
 *   - `preview`        240×240 WebP — settings page thumbnail.
 *   - `public-hero`    800×800 WebP — donor-facing hero (donation page,
 *                      Keycloak login template `logo_url`).
 *   - `pdf-letterhead` 360×360 PNG @ 300 DPI — embedded in postal-letter
 *                      PDFs. PNG (not WebP) because PDFKit's
 *                      `doc.image` only accepts PNG/JPEG.
 *
 * For SVG input we rasterise to PNG via libvips/librsvg first, then
 * derive the four variants from that intermediate. Phase 1 never
 * serves raw SVG to anonymous donors (issue spec §6).
 *
 * EXIF + colour profile are stripped from raster originals via
 * `withMetadata({})` before any variant is derived — donors don't
 * need GPS coordinates or photographer names embedded in the org logo.
 */

import type { BrandingVariantKey } from "@givernance/shared/schema";
import sharp from "sharp";
import { sanitiseSvg } from "../lib/svg-sanitiser.js";

export interface BrandingPipelineResult {
  /**
   * The four derived variants, keyed by `BrandingVariantKey`. The
   * worker's processor uploads each entry to its own S3 key.
   */
  variants: Record<BrandingVariantKey, { buffer: Buffer; contentType: string }>;
  /**
   * Sanitised + EXIF-stripped original. For raster input this is the
   * input round-tripped through sharp; for SVG it's the
   * DOMPurify-sanitised text.
   */
  originalNormalised: Buffer;
  /**
   * Source raster dimensions (post-rasterisation for SVG). Useful for
   * the audit trail and for the admin UI to surface "your upload was
   * Xpx wide; for crisp letterheads we recommend ≥800px".
   */
  sourceWidth: number;
  sourceHeight: number;
}

const SIDEBAR_SIZE = 128;
const PREVIEW_SIZE = 240;
const PUBLIC_HERO_SIZE = 800;
const PDF_LETTERHEAD_SIZE = 360;
const PDF_DPI = 300;

// Cap dimensions on raster decoding so a "billion-pixel" SVG/PNG can't
// allocate an 80 GB pixel buffer inside libvips. Mirrors the API
// handler's pre-flight 4096×4096 cap.
const MAX_INPUT_PIXELS = 4096 * 4096;

/**
 * Run the full pipeline. `mime` is the magic-byte-validated MIME of
 * the original. The caller must ensure SVG inputs have already been
 * pre-sanitised at upload time — this function will sanitise again as
 * defense-in-depth so the steady-state worker run is safe regardless
 * of how the buffer reached S3.
 */
export async function runBrandingPipeline(
  original: Buffer,
  mime: string,
): Promise<BrandingPipelineResult> {
  let rasterSource: Buffer;
  let originalNormalised: Buffer;
  const isSvg = mime === "image/svg+xml";

  if (isSvg) {
    // Sanitise first — never let an unsanitised SVG reach sharp's
    // librsvg backend (a malformed SVG could exploit a librsvg parse
    // bug). The sanitised text is also what we persist as the
    // "original" so the audit trail matches what we rasterised.
    originalNormalised = sanitiseSvg(original);
    // Rasterise to a high-res PNG bitmap. The density flag tells
    // libvips to render the SVG at 300 DPI so the public-hero (800px)
    // and pdf-letterhead (360px) variants downstream don't sample a
    // blurry 96-DPI surface.
    rasterSource = await sharp(originalNormalised, {
      density: PDF_DPI,
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .png()
      .toBuffer();
  } else {
    // Round-trip raster originals through sharp to strip EXIF + ICC
    // profile. Sharp's default (no `.withMetadata()` / `.keepMetadata()`)
    // is to drop metadata — we rely on that. The `.rotate()` step bakes
    // any EXIF orientation into the pixels first so the visual is
    // preserved when the EXIF chunk is removed.
    originalNormalised = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .toBuffer();
    rasterSource = originalNormalised;
  }

  const meta = await sharp(rasterSource).metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;

  // ── Derive the four variants in parallel ───────────────────────────
  // Each variant is `contain`ed (preserving aspect ratio, no crop) onto
  // a transparent canvas — most NPO logos are wider than tall and we'd
  // rather pad than chop the wordmark.

  const fitContain = sharp.fit.contain;
  const transparentBg = { r: 0, g: 0, b: 0, alpha: 0 };

  const [sidebar, preview, publicHero, pdfLetterhead] = await Promise.all([
    sharp(rasterSource)
      .resize(SIDEBAR_SIZE, SIDEBAR_SIZE, { fit: fitContain, background: transparentBg })
      .webp({ quality: 85 })
      .toBuffer(),
    sharp(rasterSource)
      .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: fitContain, background: transparentBg })
      .webp({ quality: 85 })
      .toBuffer(),
    sharp(rasterSource)
      .resize(PUBLIC_HERO_SIZE, PUBLIC_HERO_SIZE, { fit: fitContain, background: transparentBg })
      .webp({ quality: 90 })
      .toBuffer(),
    // PNG (not WebP) — PDFKit's doc.image() only accepts PNG / JPEG.
    // 300 DPI metadata so a print shop sampling at print resolution
    // gets a 1.2-inch-square logo (360px ÷ 300 DPI).
    sharp(rasterSource, { density: PDF_DPI })
      .resize(PDF_LETTERHEAD_SIZE, PDF_LETTERHEAD_SIZE, {
        fit: fitContain,
        background: transparentBg,
      })
      .withMetadata({ density: PDF_DPI })
      .png()
      .toBuffer(),
  ]);

  return {
    variants: {
      sidebar: { buffer: sidebar, contentType: "image/webp" },
      preview: { buffer: preview, contentType: "image/webp" },
      "public-hero": { buffer: publicHero, contentType: "image/webp" },
      "pdf-letterhead": { buffer: pdfLetterhead, contentType: "image/png" },
    },
    originalNormalised,
    sourceWidth,
    sourceHeight,
  };
}

/**
 * File extension for a derived variant — used to compose the
 * `{org}/logo/{id}/{variant}.{ext}` S3 key.
 */
export function variantExtension(key: BrandingVariantKey): string {
  return key === "pdf-letterhead" ? "png" : "webp";
}
