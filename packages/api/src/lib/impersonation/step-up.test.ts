/**
 * Unit tests for `validateStepUp` — both env modes.
 *
 * Pass `requireAcr2` explicitly so the test doesn't need to mock the env
 * module (mocking env conflicts with the integration setup file that
 * also imports it). The integration test exercises the dev/permissive
 * path against a real Fastify app; this file pins both paths' contracts.
 */

import { describe, expect, it } from "vitest";
import { STEP_UP_AUTH_TIME_WINDOW_SECONDS, validateStepUp } from "./step-up.js";

describe("validateStepUp — strict mode (requireAcr2=true)", () => {
  it("rejects when auth_time is missing (no_auth_time)", () => {
    const result = validateStepUp({ acr: "2" }, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_auth_time");
  });

  it("rejects when auth_time is older than the window (auth_time_stale)", () => {
    const stale = Math.floor(Date.now() / 1000) - STEP_UP_AUTH_TIME_WINDOW_SECONDS - 60;
    const result = validateStepUp({ auth_time: stale, acr: "2" }, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_time_stale");
    expect(result.ageSeconds).toBeGreaterThan(STEP_UP_AUTH_TIME_WINDOW_SECONDS);
  });

  it("rejects when acr is below 2 (acr_insufficient)", () => {
    const fresh = Math.floor(Date.now() / 1000) - 30;
    const result = validateStepUp({ auth_time: fresh, acr: "1" }, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("acr_insufficient");
    expect(result.acr).toBe("1");
  });

  it("rejects when acr is missing (acr_insufficient)", () => {
    const fresh = Math.floor(Date.now() / 1000) - 30;
    const result = validateStepUp({ auth_time: fresh }, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("acr_insufficient");
  });

  it("accepts when auth_time is fresh AND acr >= 2", () => {
    const fresh = Math.floor(Date.now() / 1000) - 30;
    const result = validateStepUp({ auth_time: fresh, acr: "2" }, true);
    expect(result.ok).toBe(true);
    expect(result.acr).toBe("2");
  });

  it("accepts acr higher than 2", () => {
    const fresh = Math.floor(Date.now() / 1000) - 30;
    const result = validateStepUp({ auth_time: fresh, acr: "3" }, true);
    expect(result.ok).toBe(true);
  });
});

describe("validateStepUp — permissive mode (requireAcr2=false)", () => {
  it("accepts a token with no auth_time and no acr", () => {
    const result = validateStepUp({}, false);
    expect(result.ok).toBe(true);
  });

  it("accepts a stale auth_time", () => {
    const stale = Math.floor(Date.now() / 1000) - 60 * 60;
    const result = validateStepUp({ auth_time: stale }, false);
    expect(result.ok).toBe(true);
  });

  it("ignores a low acr — RBAC + rate-limit + lockout are the in-mode gates", () => {
    const result = validateStepUp({ acr: "1" }, false);
    expect(result.ok).toBe(true);
  });
});
