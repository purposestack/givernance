/**
 * Unit tests for the CAPTCHA verifier (F5).
 *
 * Every signup integration test bypasses captcha via the `NODE_ENV=test
 * → mode=disabled` default, so the helper itself had no direct coverage
 * for its fail-open / fail-closed branches. This file pins:
 *  - `disabled` mode accepts an undefined token (dev/CI / preview).
 *  - `prod` mode rejects with `missing_secret` when no secret is wired.
 *  - `prod` mode rejects with `missing_token` when the request omits one.
 *  - `prod` mode forwards to the provider and surfaces `provider_rejected`
 *    on `success: false`.
 *  - `prod` mode reports `provider_unreachable` when the provider 5xxes
 *    or fetch throws.
 *  - Explicit `CAPTCHA_MODE=prod` overrides the `NODE_ENV` default so a
 *    non-prod environment (staging, preview) can opt-in to real captcha.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptchaVerifier } from "./captcha.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CAPTCHA_MODE = process.env.CAPTCHA_MODE;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_CAPTCHA_MODE === undefined) {
    delete process.env.CAPTCHA_MODE;
  } else {
    process.env.CAPTCHA_MODE = ORIGINAL_CAPTCHA_MODE;
  }
});

describe("createCaptchaVerifier — disabled mode (dev/CI fail-open)", () => {
  it("accepts an undefined token", async () => {
    const verifier = createCaptchaVerifier({ mode: "disabled" });
    const result = await verifier.verify(undefined);
    expect(result.ok).toBe(true);
  });

  it("accepts an arbitrary token without contacting the provider", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("provider must not be called in disabled mode");
    });
    const verifier = createCaptchaVerifier({
      mode: "disabled",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the test
      fetchImpl: fetchSpy as any,
    });
    const result = await verifier.verify("anything");
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("createCaptchaVerifier — prod mode fail-closed gates", () => {
  it("rejects with missing_secret when no secret is configured", async () => {
    const verifier = createCaptchaVerifier({ mode: "prod", secret: undefined });
    const result = await verifier.verify("some-token");
    expect(result).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects with missing_token when the request carries no captcha token", async () => {
    const verifier = createCaptchaVerifier({ mode: "prod", secret: "hcaptcha-secret" });
    const result = await verifier.verify(undefined);
    expect(result).toEqual({ ok: false, reason: "missing_token" });
  });

  it("surfaces provider_rejected when hCaptcha returns success:false", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    const verifier = createCaptchaVerifier({
      mode: "prod",
      secret: "hcaptcha-secret",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the test
      fetchImpl: fetchImpl as any,
    });
    const result = await verifier.verify("rejected-token");
    expect(result).toEqual({ ok: false, reason: "provider_rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider_unreachable on a 5xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const verifier = createCaptchaVerifier({
      mode: "prod",
      secret: "hcaptcha-secret",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the test
      fetchImpl: fetchImpl as any,
    });
    const result = await verifier.verify("token");
    expect(result).toEqual({ ok: false, reason: "provider_unreachable" });
  });

  it("surfaces provider_unreachable when fetch throws (network outage)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const verifier = createCaptchaVerifier({
      mode: "prod",
      secret: "hcaptcha-secret",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the test
      fetchImpl: fetchImpl as any,
    });
    const result = await verifier.verify("token");
    expect(result).toEqual({ ok: false, reason: "provider_unreachable" });
  });

  it("forwards the remoteip when provided", async () => {
    let captured: URLSearchParams | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      captured = new URLSearchParams(init.body as string);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const verifier = createCaptchaVerifier({
      mode: "prod",
      secret: "hcaptcha-secret",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the test
      fetchImpl: fetchImpl as any,
    });
    const result = await verifier.verify("token", "203.0.113.5");
    expect(result.ok).toBe(true);
    expect(captured?.get("secret")).toBe("hcaptcha-secret");
    expect(captured?.get("response")).toBe("token");
    expect(captured?.get("remoteip")).toBe("203.0.113.5");
  });
});

describe("createCaptchaVerifier — mode precedence", () => {
  // The default resolver checks: explicit config > CAPTCHA_MODE env >
  // NODE_ENV-based default. These tests pin that staging / preview envs
  // can opt-in to real captcha by setting CAPTCHA_MODE=prod even though
  // NODE_ENV is "development" or "test".
  beforeEach(() => {
    // Force a non-prod NODE_ENV so the default would be `disabled` —
    // a CAPTCHA_MODE=prod override must still win.
    process.env.NODE_ENV = "development";
  });

  it("CAPTCHA_MODE=prod overrides NODE_ENV=development", async () => {
    process.env.CAPTCHA_MODE = "prod";
    const verifier = createCaptchaVerifier({ secret: undefined });
    const result = await verifier.verify("token");
    // Hits the fail-closed branch (no secret) instead of the disabled
    // fail-open branch — proves CAPTCHA_MODE took precedence.
    expect(result).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("explicit config.mode overrides CAPTCHA_MODE env", async () => {
    process.env.CAPTCHA_MODE = "prod";
    const verifier = createCaptchaVerifier({ mode: "disabled" });
    const result = await verifier.verify(undefined);
    expect(result.ok).toBe(true);
  });

  it("CAPTCHA_MODE=disabled overrides a production NODE_ENV", async () => {
    process.env.NODE_ENV = "production";
    process.env.CAPTCHA_MODE = "disabled";
    const verifier = createCaptchaVerifier();
    const result = await verifier.verify(undefined);
    expect(result.ok).toBe(true);
  });
});
