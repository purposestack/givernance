/**
 * Unit coverage for `resolvePayloadLocale` (issue #153 / PR #158 QA review).
 *
 * Covers the rolling-deploy invariant: a job enqueued by the pre-#158 API
 * (carrying only `country`) must still render in the right language when
 * drained by a post-#158 worker. Once the queue has drained and the
 * legacy `country` branch is removed, this suite shrinks to the happy
 * path + the default-fallback case.
 */

import { describe, expect, it, vi } from "vitest";
import { resolvePayloadLocale } from "./payload-locale.js";

function makeLog() {
  return { warn: vi.fn() };
}

describe("resolvePayloadLocale", () => {
  it("prefers payload.locale when it's a supported BCP-47 value", () => {
    const log = makeLog();
    expect(resolvePayloadLocale({ locale: "fr" }, log)).toBe("fr");
    expect(resolvePayloadLocale({ locale: "en" }, log)).toBe("en");
    // Happy path emits no warn — only the fallbacks do.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("ignores an unsupported locale and falls back to country", () => {
    const log = makeLog();
    expect(resolvePayloadLocale({ locale: "de", country: "FR" }, log)).toBe("fr");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("derives 'fr' from a legacy country='FR' payload (case-insensitive)", () => {
    const log = makeLog();
    expect(resolvePayloadLocale({ country: "FR" }, log)).toBe("fr");
    expect(resolvePayloadLocale({ country: "fr" }, log)).toBe("fr");
    expect(log.warn).toHaveBeenCalledTimes(2);
    // Each warn carries the country for SRE breadcrumbs.
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ country: "FR" });
  });

  it("derives 'en' from a legacy non-FR country payload", () => {
    const log = makeLog();
    expect(resolvePayloadLocale({ country: "BE" }, log)).toBe("en");
    expect(resolvePayloadLocale({ country: "DE" }, log)).toBe("en");
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("falls back to APP_DEFAULT_LOCALE ('fr') when neither field is present", () => {
    const log = makeLog();
    expect(resolvePayloadLocale({}, log)).toBe("fr");
    expect(log.warn).toHaveBeenCalledOnce();
    // The "missing both fields" warn carries an empty object so SRE can
    // grep on the message text without filtering by `country`.
    expect(log.warn.mock.calls[0]?.[0]).toEqual({});
  });

  it("treats empty / whitespace-only country as missing", () => {
    const log = makeLog();
    expect(resolvePayloadLocale({ country: "" }, log)).toBe("fr");
    expect(resolvePayloadLocale({ country: "   " }, log)).toBe("fr");
  });
});
