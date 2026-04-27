/**
 * Unit coverage for `resolvePayloadLocale` (issue #153).
 */

import { describe, expect, it } from "vitest";
import { resolvePayloadLocale } from "./payload-locale.js";

describe("resolvePayloadLocale", () => {
  it("returns the payload locale when it's a supported BCP-47 value", () => {
    expect(resolvePayloadLocale({ locale: "fr" })).toBe("fr");
    expect(resolvePayloadLocale({ locale: "en" })).toBe("en");
  });

  it("falls back to APP_DEFAULT_LOCALE ('fr') when the locale is unsupported", () => {
    expect(resolvePayloadLocale({ locale: "de" })).toBe("fr");
  });

  it("falls back to APP_DEFAULT_LOCALE ('fr') when the locale is missing", () => {
    expect(resolvePayloadLocale({})).toBe("fr");
  });
});
