import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserFetch } from "./client-browser";

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
