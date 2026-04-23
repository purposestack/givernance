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
