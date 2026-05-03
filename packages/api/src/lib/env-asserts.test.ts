import { describe, expect, it } from "vitest";

import { assertImpersonationStepUpRequired } from "../env.js";

/**
 * Locks the production-mode contract for `IMPERSONATION_REQUIRE_ACR_2`.
 * The boot check itself lives inline in `env.ts` (it has to call
 * `process.exit(1)`); this suite exercises the pure assertion function
 * extracted alongside it so a regression in the prod gate surfaces
 * here before it ships to staging. Multi-agent review API-2 (PR #251)
 * flagged the absence of any test on this contract — the only barrier
 * between a stolen super-admin cookie and an arbitrary impersonation
 * session is this flag being `true` in prod, so the check earns a
 * dedicated test.
 */
describe("assertImpersonationStepUpRequired", () => {
  it("rejects production + requireAcr2=false (the catastrophic misconfig)", () => {
    const res = assertImpersonationStepUpRequired({
      nodeEnv: "production",
      requireAcr2: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Lock the message shape — operators grepping for this string in
      // CI logs / Loki should always find it. The "issue #24" tail is
      // the cross-reference so a confused on-call reaches the design
      // doc faster than the source.
      expect(res.reason).toMatch(/IMPERSONATION_REQUIRE_ACR_2 must be `true` in production/);
      expect(res.reason).toMatch(/issue #24/);
    }
  });

  it("accepts production + requireAcr2=true", () => {
    expect(
      assertImpersonationStepUpRequired({
        nodeEnv: "production",
        requireAcr2: true,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts development + requireAcr2=false (dev escape valve)", () => {
    expect(
      assertImpersonationStepUpRequired({
        nodeEnv: "development",
        requireAcr2: false,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts test + requireAcr2=false (test escape valve — same as dev)", () => {
    expect(
      assertImpersonationStepUpRequired({
        nodeEnv: "test",
        requireAcr2: false,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts undefined NODE_ENV + requireAcr2=false (no implicit prod)", () => {
    expect(
      assertImpersonationStepUpRequired({
        nodeEnv: undefined,
        requireAcr2: false,
      }),
    ).toEqual({ ok: true });
  });
});
