import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserFetch, setImpersonationActive } from "./client-browser";

describe("createBrowserFetch", () => {
  afterEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: testing mock
    document.cookie = "csrf-token=; Max-Age=0; path=/";
  });

  it("adds the CSRF header from the double-submit cookie on mutating requests", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: testing mock
    document.cookie = "csrf-token=csrf-test-token; path=/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const browserFetch = createBrowserFetch(fetchMock as typeof fetch);
    await browserFetch("https://example.test/v1/example", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-test-token");
  });

  it("does not add the CSRF header on safe requests", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: testing mock
    document.cookie = "csrf-token=csrf-test-token; path=/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const browserFetch = createBrowserFetch(fetchMock as typeof fetch);
    await browserFetch("https://example.test/v1/example", { method: "GET" });

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).has("X-CSRF-Token")).toBe(false);
  });
});

describe("createBrowserFetch — impersonation-expiry recovery", () => {
  const originalLocation = window.location;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom forbids spying on `window.location.assign` directly — replace the
    // whole location object instead (see feedback_jsdom_location_assign_stub).
    assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: assignMock },
    });
    setImpersonationActive(false);
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    setImpersonationActive(false);
  });

  function fetchReturning(status: number) {
    return vi.fn().mockResolvedValue(new Response(null, { status }));
  }

  it("navigates to restore-session on a 401 when impersonation is active (issue #296)", async () => {
    setImpersonationActive(true);
    const browserFetch = createBrowserFetch(fetchReturning(401) as typeof fetch);

    const response = await browserFetch("https://example.test/v1/example");

    // Routes through restore-session (which refreshes the operator session
    // from the /api/auth-scoped refresh cookie) rather than straight to the
    // impersonation list — see client-browser.ts IMPERSONATION_RECOVERY_PATH.
    expect(assignMock).toHaveBeenCalledWith(
      "/api/auth/restore-session?return=%2Fadmin%2Fimpersonation",
    );
    // The response is still returned so the caller's error handling runs.
    expect(response.status).toBe(401);
  });

  it("does NOT navigate on a 401 when impersonation is inactive", async () => {
    setImpersonationActive(false);
    const browserFetch = createBrowserFetch(fetchReturning(401) as typeof fetch);

    await browserFetch("https://example.test/v1/example");

    expect(assignMock).not.toHaveBeenCalled();
  });

  it("does NOT navigate on a non-401 response even when impersonating", async () => {
    setImpersonationActive(true);
    const browserFetch = createBrowserFetch(fetchReturning(200) as typeof fetch);

    await browserFetch("https://example.test/v1/example");

    expect(assignMock).not.toHaveBeenCalled();
  });
});
