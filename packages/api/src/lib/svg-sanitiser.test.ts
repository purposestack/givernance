/**
 * SVG sanitiser unit tests — PR #287 review (minor 14).
 *
 * The route-level integration tests in `branding.test.ts` already cover
 * the loud-rejection paths (`<script>`, `onclick=…`) that the pre-flight
 * regex catches before DOMPurify even runs. This file complements them
 * with positive coverage for two attack vectors that DOMPurify's SVG
 * profile silently neutralises rather than rejecting outright:
 *
 *   - `<a xlink:href="javascript:…">` — JS-pseudo-protocol smuggled
 *     through an anchor inside an SVG. The pre-flight regex won't
 *     catch this (no `on*=` attribute, no `<script>` tag); we rely on
 *     DOMPurify to strip the `href`. If a future DOMPurify version
 *     regresses on this, donor browsers loading the served raster will
 *     be safe (rasterisation throws away markup) but the in-bucket
 *     sanitised SVG would carry the gadget — defense-in-depth wants
 *     this caught at the sanitiser layer.
 *
 *   - `<image href="data:…">` — embedded raster smuggled via a
 *     data-URI. Not a code-execution gadget, but it inflates the
 *     stored "logo" with arbitrary bytes the operator never reviewed,
 *     and `<image>` outside DOMPurify's allowlist is the policy we
 *     want to lock in.
 *
 * Both tests assert the cleaned output, then a benign round-trip
 * confirms a plain `<rect>` / `<path>` survives sanitisation unchanged
 * — so a regression that nukes everything (DOMPurify config drift)
 * fails loudly here.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { MAX_SVG_ELEMENTS, SvgSanitiserError, sanitiseSvg } from "./svg-sanitiser.js";

describe("sanitiseSvg — DOMPurify positive coverage", () => {
  it("strips javascript: pseudo-protocol from <a xlink:href>", () => {
    // The pre-flight regex doesn't fire here: no `<script>`, no
    // `<foreignObject>`, no `on*=` attribute, no external `<use href>`.
    // DOMPurify's SVG profile is the only line of defense.
    const input = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><rect width="10" height="10" /></a></svg>`,
      "utf8",
    );

    const cleaned = sanitiseSvg(input).toString("utf8");

    // Strict string assertion: `javascript` must not appear at all.
    // DOMPurify strips the dangerous href but may keep the wrapping
    // element with a stripped or sanitised attribute — either is
    // acceptable as long as the protocol is gone.
    expect(cleaned.toLowerCase()).not.toContain("javascript");

    // Belt-and-suspenders: parse the output and assert no anchor in
    // the resulting tree carries a JS-protocol href. Catches a
    // future DOMPurify regression that case-folds `JaVaScRiPt:` past
    // the substring check.
    const dom = new JSDOM(cleaned, { contentType: "image/svg+xml" });
    const anchors = dom.window.document.querySelectorAll("a");
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
      expect(href.toLowerCase()).not.toMatch(/^\s*javascript:/);
    }
  });

  it("strips data: URI from <image href> (or removes the element entirely)", () => {
    // DOMPurify's SVG profile rejects `<image>` by default; we lock
    // that policy in here. If a future config change opts `<image>`
    // back in, this test fails and forces a follow-up policy review.
    const input = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" width="10" height="10"/></svg>`,
      "utf8",
    );

    const cleaned = sanitiseSvg(input).toString("utf8");

    // The data URI must not survive — either because DOMPurify
    // dropped the element or because it stripped the href to a
    // harmless form. A literal `data:` substring in the output would
    // mean we're serving an attacker-supplied raster from the
    // branding bucket as if it were the operator's logo.
    expect(cleaned.toLowerCase()).not.toContain("data:image");
    expect(cleaned.toLowerCase()).not.toContain("base64,");

    // Lock the actual policy: `<image>` is not in the allowlist, so
    // the element should be gone after sanitisation. If this assertion
    // ever needs to flip (because we explicitly opt `<image>` in),
    // make sure the data:-href cap above is still enforced.
    const dom = new JSDOM(cleaned, { contentType: "image/svg+xml" });
    const images = dom.window.document.querySelectorAll("image");
    expect(images.length).toBe(0);
  });

  it("round-trips a benign SVG without dropping content", () => {
    // Counterweight to the two stripping tests above: a plain SVG
    // with only allowlisted shapes must survive sanitisation. If
    // DOMPurify's config drifts to a permission-denied posture (e.g.
    // someone forgets `USE_PROFILES: { svg: true }`), every benign
    // logo upload would silently empty out — this test fails first.
    const input = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#3366cc"/><path d="M20 20 L80 80" stroke="black" stroke-width="2"/></svg>`,
      "utf8",
    );

    const cleaned = sanitiseSvg(input).toString("utf8");

    expect(cleaned.toLowerCase()).toContain("<svg");
    expect(cleaned.toLowerCase()).toContain("<rect");
    expect(cleaned.toLowerCase()).toContain("<path");
    expect(cleaned).toContain('fill="#3366cc"');
  });
});

describe("sanitiseSvg — element-count cap (issue #295)", () => {
  /** Build an `<svg>` wrapper containing `n` tiny `<rect>` children. */
  function svgWithRects(n: number): Buffer {
    const rects = '<rect width="1" height="1"/>'.repeat(n);
    return Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">${rects}</svg>`,
      "utf8",
    );
  }

  it("rejects a pathological SVG that blows past the element cap", () => {
    // The classic OOM vector: thousands of tiny elements, each well under
    // the 1MB byte cap, that would inflate the jsdom parser DOM. The regex
    // pre-flight must reject this BEFORE jsdom ever parses it.
    const input = svgWithRects(MAX_SVG_ELEMENTS + 500);

    expect(() => sanitiseSvg(input)).toThrow(SvgSanitiserError);
    try {
      sanitiseSvg(input);
      expect.unreachable("expected sanitiseSvg to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SvgSanitiserError);
      expect((err as SvgSanitiserError).reason).toBe("too_complex");
    }
  });

  it("accepts a dense-but-legitimate SVG just under the cap", () => {
    // A complex real logo (~200 paths) or vector portrait (~1000) must
    // sail through. We test comfortably below the ceiling: the wrapper
    // `<svg>` counts as one element, so (cap - 100) rects stays under.
    const input = svgWithRects(MAX_SVG_ELEMENTS - 100);

    const cleaned = sanitiseSvg(input).toString("utf8");
    expect(cleaned.toLowerCase()).toContain("<svg");
    expect(cleaned.toLowerCase()).toContain("<rect");
  });

  it("counts opening tags only — closing tags don't inflate the count", () => {
    // `<g>…</g>` pairs must not be double-counted: a document with N
    // group elements has N opening tags, not 2N. If the counter matched
    // closing tags too, a document with (cap/2 + 1) groups would falsely
    // trip. Build exactly that and assert it survives.
    const groups = "<g></g>".repeat(Math.floor(MAX_SVG_ELEMENTS / 2) + 1);
    const input = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">${groups}</svg>`,
      "utf8",
    );

    // Opening-tag count = 1 (<svg>) + (cap/2 + 1) groups, which is < cap.
    expect(() => sanitiseSvg(input)).not.toThrow();
  });
});
