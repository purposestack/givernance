/**
 * SVG sanitiser — worker copy. **Lockstep with**
 * `packages/api/src/lib/svg-sanitiser.ts`.
 *
 * The API handler sanitises the SVG before writing to S3, so the
 * worker reads an already-clean blob in the steady state. This copy
 * exists so the worker can re-sanitise defensively on retry (the
 * stored object could in theory be tampered with between writes,
 * however unlikely with our infra) and so the rasterisation step
 * has a guaranteed-safe input regardless of which path produced it.
 *
 * If you change the API copy, change this one in lockstep — the two
 * MUST behave identically.
 */

// biome-ignore lint/suspicious/noExplicitAny: dompurify's type exports vary across versions
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

export class SvgSanitiserError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "contains_script"
      | "contains_foreign_object"
      | "contains_external_use"
      | "contains_event_handler"
      | "parse_error"
      | "not_svg",
  ) {
    super(message);
    this.name = "SvgSanitiserError";
  }
}

export function sanitiseSvg(input: Buffer): Buffer {
  const text = input.toString("utf8");
  const lower = text.toLowerCase();

  if (/<script\b/i.test(text)) {
    throw new SvgSanitiserError("SVG contains <script>", "contains_script");
  }
  if (/<foreignobject\b/i.test(text)) {
    throw new SvgSanitiserError("SVG contains <foreignObject>", "contains_foreign_object");
  }
  if (/\son[a-z]+\s*=/i.test(text)) {
    throw new SvgSanitiserError("SVG contains event handler attribute", "contains_event_handler");
  }
  const useRegex = /<use\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic global regex iteration
  while ((match = useRegex.exec(text)) !== null) {
    const href = match[1] ?? "";
    if (!href.startsWith("#")) {
      throw new SvgSanitiserError(
        "SVG <use href> points outside the document",
        "contains_external_use",
      );
    }
  }
  if (!lower.includes("<svg")) {
    throw new SvgSanitiserError("Input does not contain an <svg> root", "not_svg");
  }

  let cleaned: string;
  try {
    const window = new JSDOM("").window;
    // biome-ignore lint/suspicious/noExplicitAny: dompurify's factory expects a Window-like
    const purify = createDOMPurify(window as any);
    cleaned = purify.sanitize(text, {
      USE_PROFILES: { svg: true, svgFilters: false },
      RETURN_TRUSTED_TYPE: false,
      FORBID_TAGS: ["script", "foreignObject"],
      FORBID_ATTR: ["onload", "onclick", "onerror", "onmouseover", "onfocus", "onblur"],
    });
  } catch (err) {
    throw new SvgSanitiserError(
      `SVG could not be parsed: ${(err as Error).message}`,
      "parse_error",
    );
  }

  if (!cleaned.toLowerCase().includes("<svg")) {
    throw new SvgSanitiserError("Input did not survive sanitisation as SVG", "not_svg");
  }

  return Buffer.from(cleaned, "utf8");
}
