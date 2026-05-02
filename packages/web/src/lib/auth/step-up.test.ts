import { describe, expect, it } from "vitest";

import { buildStepUpRedirectUrl } from "./step-up";

describe("buildStepUpRedirectUrl", () => {
  // The login route only forwards acr_values when it equals "2" — any other
  // value is dropped server-side. Locking the literal here means a typo
  // ("acr=2", "acr_values=loa-2") fails the test instead of silently
  // shipping a no-op redirect that the user perceives as "MFA didn't work".
  it("forwards acr_values=2 + prompt=login + the same-origin return_to", () => {
    const url = new URL(
      buildStepUpRedirectUrl("https://app.givernance.org", "/admin/impersonation/new"),
    );
    expect(url.origin).toBe("https://app.givernance.org");
    expect(url.pathname).toBe("/api/auth/login");
    expect(url.searchParams.get("acr_values")).toBe("2");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("return_to")).toBe("/admin/impersonation/new");
  });

  // URL encoding regression test — `URLSearchParams.set` already encodes,
  // so a raw `?` or `&` in `return_to` shouldn't smuggle additional
  // params into the login URL. If a future refactor uses string
  // concatenation instead, this test catches it.
  it("URL-encodes the return_to path", () => {
    const url = new URL(
      buildStepUpRedirectUrl("https://app.example", "/admin/x?intercepted=1&hostile=2"),
    );
    // The intercepted/hostile params live INSIDE the encoded return_to value,
    // not as top-level query params on the login URL.
    expect(url.searchParams.get("intercepted")).toBeNull();
    expect(url.searchParams.get("hostile")).toBeNull();
    expect(url.searchParams.get("return_to")).toBe("/admin/x?intercepted=1&hostile=2");
  });
});
