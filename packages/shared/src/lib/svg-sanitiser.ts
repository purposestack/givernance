/**
 * SVG sanitiser — Epic #286 (shared, issue #480).
 *
 * Org-logo upload accepts SVG so a vector logo from the operator's
 * brand kit renders crisply at every size. SVG is, however, a markup
 * language: it can carry inline `<script>`, JS-bearing `on*` event
 * attributes, external `<use href>` references, and `<foreignObject>`
 * subtrees that hide HTML inside the SVG namespace. Any of those
 * stored verbatim and served from the branding bucket would be a
 * stored-XSS vector against any donor browser that ever loaded it.
 *
 * Defense-in-depth posture (issue spec §6):
 *   1. **At upload time** (API): this sanitiser strips every dangerous
 *      construct via DOMPurify (using its SVG profile).
 *   2. **At render time** (worker): the worker re-sanitises defensively
 *      on retry, then rasterises the sanitised SVG to PNG/WebP variants,
 *      and we never serve raw SVG to anonymous donors in Phase 1. The
 *      original SVG stays in S3 for audit / future re-processing only.
 *
 * One implementation, dependency-free of any DB/env, lives here and is
 * imported by BOTH the API (upload handler) and the worker (rasterisation
 * pipeline) via the `@givernance/shared/lib/svg-sanitiser` subpath — so
 * the two paths behave IDENTICALLY and cannot drift.
 *
 * Rejected (vs. accepted with strip) — these are explicit, vocal
 * failures because their presence implies the upload is hostile, not
 * accidentally over-rich:
 *   - `<script>` element (XSS).
 *   - `<foreignObject>` subtree (HTML smuggling).
 *   - `<use href>` to a non-fragment URL (SSRF / cross-origin XML).
 *   - Any attribute starting with `on` (inline event handlers).
 *
 * Stripped silently (DOMPurify's default for the SVG profile):
 *   - Most filters, animations, embedded fonts. We don't reject these
 *     because they're commonly produced by design tools and harmless
 *     once the SVG renders flat — but the rasterisation step makes
 *     them moot anyway.
 */

import createDOMPurify, { type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";

/**
 * Upper bound on the number of markup elements a single logo SVG may
 * contain (issue #295). The 1 MB byte cap enforced upstream is not a
 * sufficient guard on its own: a pathological SVG built from ~100k tiny
 * `<rect>` elements (≈ 10 bytes each) passes the byte cap yet inflates
 * jsdom's parser DOM enough to spike memory / CPU before DOMPurify runs.
 *
 * 5,000 is a generous ceiling for a real logo — a complex flat-design
 * org logo is ~200 paths, and even a vector hand-drawn portrait tops out
 * around ~1,000. It rejects pathology without ever tripping on a
 * legitimate upload.
 */
export const MAX_SVG_ELEMENTS = 5000;

export class SvgSanitiserError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "contains_script"
      | "contains_foreign_object"
      | "contains_external_use"
      | "contains_event_handler"
      | "too_complex"
      | "parse_error"
      | "not_svg",
  ) {
    super(message);
    this.name = "SvgSanitiserError";
  }
}

/**
 * Validate + sanitise raw SVG bytes. Returns the sanitised SVG as a
 * Buffer suitable for either S3 storage (audit) or sharp rasterisation.
 *
 * Throws `SvgSanitiserError` with a typed `reason` when the input
 * trips one of the explicit rejection rules. The API handler catches
 * this and returns a 400 with the reason in the problem detail.
 */
export function sanitiseSvg(input: Buffer): Buffer {
  const text = input.toString("utf8");

  // Cheap pre-flight to catch the worst offenders even before we let
  // jsdom parse the document. A truly malformed SVG would throw inside
  // jsdom and we'd surface that as `parse_error` — but we want crisp,
  // explicit errors for the common attack patterns.
  const lower = text.toLowerCase();
  if (/<script\b/i.test(text)) {
    throw new SvgSanitiserError("SVG contains <script>", "contains_script");
  }
  if (/<foreignobject\b/i.test(text)) {
    throw new SvgSanitiserError("SVG contains <foreignObject>", "contains_foreign_object");
  }
  // `on*=` attributes — the regex is loose on purpose; legitimate SVGs
  // never carry these. Matches `onclick=`, ` onload =`, etc.
  if (/\son[a-z]+\s*=/i.test(text)) {
    throw new SvgSanitiserError("SVG contains event handler attribute", "contains_event_handler");
  }
  // External `<use href="…">` — we accept fragment-only refs (`#id`)
  // but reject anything that pulls remote content.
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

  // Fast non-fatal SVG-ness check: the document must contain an `<svg`
  // tag. Stops a JPEG-with-fake-extension from silently round-tripping
  // into the rasteriser as an empty document.
  if (!lower.includes("<svg")) {
    throw new SvgSanitiserError("Input does not contain an <svg> root", "not_svg");
  }

  // Element-count cap (issue #295) — MUST run before the jsdom parse
  // below. Counting opening tags with a cheap regex on the raw text is
  // O(n) over the (already ≤1 MB) input — a bounded transient match
  // array, far cheaper than the ~100 MB DOM it prevents; letting a
  // 100k-element document reach jsdom is exactly the OOM/CPU pathology
  // this guards against. We match
  // the start of every opening tag (`<` immediately followed by a letter)
  // which counts `<svg`, `<rect`, … but not closing tags (`</rect>`),
  // comments (`<!--`), the XML declaration (`<?xml`), or CDATA — an
  // over-count would only ever make the guard *stricter*, never leakier.
  const elementCount = (text.match(/<[a-z]/gi) ?? []).length;
  if (elementCount > MAX_SVG_ELEMENTS) {
    throw new SvgSanitiserError(
      `SVG has ${elementCount} elements, exceeding the ${MAX_SVG_ELEMENTS} cap`,
      "too_complex",
    );
  }

  let cleaned: string;
  try {
    const window = new JSDOM("").window;
    // JSDOM's `DOMWindow` is structurally compatible with dompurify's
    // `WindowLike` but TypeScript can't see it as such — `WindowLike` picks
    // a narrow subset of properties from the global `Window` shape.
    // Importing the named type from dompurify and routing through `unknown`
    // satisfies the typechecker without resorting to `any`.
    const purify = createDOMPurify(window as unknown as WindowLike);
    cleaned = purify.sanitize(text, {
      // Treat the input as SVG, not HTML — keeps the namespace correct
      // and avoids DOMPurify trying to wrap it in `<body>`.
      USE_PROFILES: { svg: true, svgFilters: false },
      // Return a string, not a TrustedHTML or Node, so we can hand it
      // straight to a Buffer.
      RETURN_TRUSTED_TYPE: false,
      // Belt-and-suspenders: forbid the constructs we already
      // pre-checked, in case a future DOMPurify version stops
      // stripping them by default. `<image>` is added because the
      // pipeline always rasterises SVG to PNG/WebP — any inline
      // `<image href="data:...">` would be dead bytes anyway, and
      // letting it through means an attacker-controlled raster could
      // ride the operator's brand bucket as if it were the org logo
      // (low-severity phishing surface flagged in the PR #287 review).
      FORBID_TAGS: ["script", "foreignObject", "image"],
      FORBID_ATTR: ["onload", "onclick", "onerror", "onmouseover", "onfocus", "onblur"],
    });
  } catch (err) {
    throw new SvgSanitiserError(
      `SVG could not be parsed: ${(err as Error).message}`,
      "parse_error",
    );
  }

  if (!cleaned.toLowerCase().includes("<svg")) {
    // DOMPurify stripped everything — input was effectively a non-SVG.
    throw new SvgSanitiserError("Input did not survive sanitisation as SVG", "not_svg");
  }

  return Buffer.from(cleaned, "utf8");
}
