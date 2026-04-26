import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

describe("ApiClient URL building", () => {
  function captureUrl(baseUrl: string) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ApiClient({ baseUrl, fetchFn: fetchMock as typeof fetch });
    return { client, fetchMock };
  }

  it("preserves the base path when the request path starts with a slash", async () => {
    const { client, fetchMock } = captureUrl("http://localhost:3000/api");
    await client.get("/v1/admin/tenants/42");

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe("http://localhost:3000/api/v1/admin/tenants/42");
  });

  it("preserves the base path when the request path does not start with a slash", async () => {
    const { client, fetchMock } = captureUrl("http://localhost:3000/api");
    await client.get("v1/admin/tenants/42");

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe("http://localhost:3000/api/v1/admin/tenants/42");
  });

  it("appends query parameters to the resolved URL", async () => {
    const { client, fetchMock } = captureUrl("http://localhost:3000/api");
    await client.get("/v1/items", { params: { page: 2, q: "foo" } });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe("http://localhost:3000/api/v1/items?page=2&q=foo");
  });

  it("works with an absolute base URL that has no path", async () => {
    const { client, fetchMock } = captureUrl("http://localhost:4000");
    await client.get("/v1/items");

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe("http://localhost:4000/v1/items");
  });
});

// Fastify's body parser rejects requests that advertise `application/json`
// but send no body (the resend / cancel flows on PR #154 hit this with a
// 400). Make sure the client doesn't set the JSON content-type unless a
// body is actually present.
describe("ApiClient Content-Type negotiation", () => {
  function captureRequestInit(method: "post" | "delete", body?: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ApiClient({
      baseUrl: "http://localhost:4000",
      fetchFn: fetchMock as typeof fetch,
    });
    const promise = method === "post" ? client.post("/v1/x", body) : client.delete("/v1/x");
    return { promise, fetchMock };
  }

  it("omits Content-Type on bodiless POSTs (resend pattern)", async () => {
    const { promise, fetchMock } = captureRequestInit("post");
    await promise;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it("omits Content-Type on DELETE", async () => {
    const { promise, fetchMock } = captureRequestInit("delete");
    await promise;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("sets Content-Type: application/json when a body is present", async () => {
    const { promise, fetchMock } = captureRequestInit("post", { email: "x@y.com" });
    await promise;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ email: "x@y.com" }));
  });
});
