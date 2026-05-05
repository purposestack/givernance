/**
 * Branding pipeline unit tests — Epic #286.
 *
 * Coverage:
 *   - PNG → 4 variants in correct sizes/formats.
 *   - EXIF stripped from raster originals.
 *   - SVG with malicious payload rejected by sanitiser before pipeline.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SvgSanitiserError } from "../lib/svg-sanitiser.js";
import { runBrandingPipeline } from "./branding-pipeline.js";

/** Build a small test PNG via sharp so the variants have something to chew on. */
async function makePng(width = 256, height = 256): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 220, g: 38, b: 38, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("runBrandingPipeline", () => {
  it("derives all four variants from a PNG input", async () => {
    const png = await makePng();
    const result = await runBrandingPipeline(png, "image/png");

    expect(Object.keys(result.variants).sort()).toEqual([
      "pdf-letterhead",
      "preview",
      "public-hero",
      "sidebar",
    ]);

    // Each variant should be a non-empty buffer.
    for (const [, val] of Object.entries(result.variants)) {
      expect(val.buffer.byteLength).toBeGreaterThan(0);
    }

    // Source dimensions captured.
    expect(result.sourceWidth).toBe(256);
    expect(result.sourceHeight).toBe(256);

    // Variant dimensions match the canonical sizes.
    const sidebar = await sharp(result.variants.sidebar.buffer).metadata();
    expect(sidebar.width).toBe(128);
    expect(sidebar.height).toBe(128);
    expect(sidebar.format).toBe("webp");

    const preview = await sharp(result.variants.preview.buffer).metadata();
    expect(preview.width).toBe(240);
    expect(preview.height).toBe(240);
    expect(preview.format).toBe("webp");

    const publicHero = await sharp(result.variants["public-hero"].buffer).metadata();
    expect(publicHero.width).toBe(800);
    expect(publicHero.height).toBe(800);
    expect(publicHero.format).toBe("webp");

    const pdf = await sharp(result.variants["pdf-letterhead"].buffer).metadata();
    expect(pdf.width).toBe(360);
    expect(pdf.height).toBe(360);
    expect(pdf.format).toBe("png");
  });

  it("strips EXIF metadata from raster originals", async () => {
    // Build a JPEG with custom EXIF (sharp accepts an exif object).
    const jpegWithExif = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .withMetadata({
        exif: {
          IFD0: { Artist: "Test Author" },
        },
      })
      .jpeg()
      .toBuffer();

    const result = await runBrandingPipeline(jpegWithExif, "image/jpeg");
    const meta = await sharp(result.originalNormalised).metadata();
    // After our `withMetadata({})` round-trip, sharp emits no exif block.
    // (sharp returns `undefined` when there's no EXIF chunk.)
    expect(meta.exif).toBeUndefined();
  });

  it("rasterises SVG input through the sanitiser to PNG variants", async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#0066cc"/></svg>`,
      "utf8",
    );
    const result = await runBrandingPipeline(svg, "image/svg+xml");
    expect(result.variants.sidebar.contentType).toBe("image/webp");
    expect(result.variants["pdf-letterhead"].contentType).toBe("image/png");
    // The sanitised "original" is still SVG.
    expect(result.originalNormalised.toString("utf8")).toMatch(/<svg/);
  });

  it("rejects SVG with <script> via the sanitiser before sharp ever sees it", async () => {
    const malicious = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      "utf8",
    );
    await expect(runBrandingPipeline(malicious, "image/svg+xml")).rejects.toBeInstanceOf(
      SvgSanitiserError,
    );
  });
});
