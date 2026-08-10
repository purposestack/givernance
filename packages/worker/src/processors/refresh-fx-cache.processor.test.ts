/**
 * Unit tests for the FX-cache warm-set (ADR-032 §2.1).
 *
 * The bug these lock down: `refresh_fx_cache` derived its warm-set purely from
 * tenant data (active bank-account currencies ∪ user display-currency overrides).
 * On a fresh deploy — or any tenant set with no EUR bank account — the set was
 * empty and the job early-returned WITHOUT fetching EUR, leaving the `/readyz`
 * fx canary (`fx:rates:EUR`) permanently cold and flapping fx → `down` despite a
 * valid FIXER_API_KEY and a running worker. The warm-set must ALWAYS include the
 * platform base currency (EUR).
 */

import { describe, expect, it } from "vitest";
import { collectCurrenciesToWarm } from "./refresh-fx-cache.processor.js";

describe("collectCurrenciesToWarm", () => {
  it("always includes the EUR base currency even with no tenant data", () => {
    expect(collectCurrenciesToWarm([], [])).toEqual(["EUR"]);
  });

  it("ignores null currency rows but still warms EUR", () => {
    expect(collectCurrenciesToWarm([{ currency: null }], [{ currency: null }])).toEqual(["EUR"]);
  });

  it("does not duplicate EUR when a bank account already settles in EUR", () => {
    expect(collectCurrenciesToWarm([{ currency: "EUR" }], [])).toEqual(["EUR"]);
  });

  it("unions bank-account + display currencies with the base, upper-cased & deduped", () => {
    const result = collectCurrenciesToWarm(
      [{ currency: "chf" }, { currency: "GBP" }, { currency: "chf" }],
      [{ currency: "usd" }, { currency: "gbp" }],
    );
    expect(new Set(result)).toEqual(new Set(["EUR", "CHF", "GBP", "USD"]));
    // EUR is present regardless of what the tenant data contains.
    expect(result).toContain("EUR");
  });
});
