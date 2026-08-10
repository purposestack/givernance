/**
 * Contract tests for the worker's minimal Keycloak Admin copy (issue #581).
 *
 * ADR-039 mandates behaviour mirroring between this copy and the
 * full-featured `packages/api/src/lib/keycloak-admin.ts` client, but the
 * two diverge structurally by design (the api copy injects fetch/clock,
 * this one uses the globals). A byte-for-byte parity test is therefore
 * impossible — instead this suite pins the shared behavioural slice with
 * the same stubbed-fetch technique as the api suite, so a mirrored fix
 * has a RED/GREEN harness to land in on the worker side:
 *  - token cache + 30s safety margin, config guards
 *  - admin-API 401 → single token rotation + retry (never a loop)
 *  - 404 idempotence (get → null, update → skipped PUT)
 *  - GET-then-PUT attribute merge + `changed` semantics
 *  - `assertSafeOrgAttributes` fires before any HTTP call (F2 JWT-leak guard)
 *
 * The module keeps its token cache in module scope, so every test reloads
 * the module (`vi.resetModules` + dynamic import) to start from a cold cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StubCall = { url: string; init: RequestInit };

const calls: StubCall[] = [];
const responders: Array<(call: StubCall) => Response | Promise<Response>> = [];
const enqueue = (r: (call: StubCall) => Response | Promise<Response>) => responders.push(r);

const ENV_DEFAULTS = {
  KEYCLOAK_URL: "http://kc.test" as string | undefined,
  KEYCLOAK_INTERNAL_URL: undefined as string | undefined,
  KEYCLOAK_ADMIN_URL: undefined as string | undefined,
  KEYCLOAK_REALM: "givernance",
  KEYCLOAK_ADMIN_CLIENT_ID: "givernance-admin",
  KEYCLOAK_ADMIN_CLIENT_SECRET: "sekret" as string | undefined,
};

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock("../env.js", () => envMock);

const warnLines = vi.hoisted(() => [] as Array<{ obj: Record<string, unknown>; msg: string }>);
vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: (obj: Record<string, unknown>, msg: string) => warnLines.push({ obj, msg }),
    error: vi.fn(),
  },
}));

let nowMs = 1_000_000;
let kc: typeof import("./keycloak-admin.js");

beforeEach(async () => {
  calls.length = 0;
  responders.length = 0;
  warnLines.length = 0;
  nowMs = 1_000_000;
  Object.assign(envMock.env, ENV_DEFAULTS);
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: StubCall = { url, init: init ?? {} };
    calls.push(call);
    const responder = responders.shift();
    if (!responder) {
      throw new Error(`Unexpected fetch to ${url} — no responder enqueued`);
    }
    return responder(call);
  });
  // The token cache lives in module scope — reload for a cold cache per test.
  vi.resetModules();
  kc = await import("./keycloak-admin.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tokenResponse = (body: { access_token?: string; expires_in?: number } = {}): Response =>
  new Response(
    JSON.stringify({
      access_token: body.access_token ?? "tok-1",
      expires_in: body.expires_in ?? 60,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const noContent = (): Response => new Response(null, { status: 204 });

const tokenCalls = () => calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
const orgCalls = () => calls.filter((c) => c.url.includes("/admin/realms/"));

const org = (attributes?: Record<string, string[]>) => ({
  id: "kc-org-1",
  name: "Acme NPO",
  alias: "acme",
  ...(attributes !== undefined ? { attributes } : {}),
});

// ─── Token cache + config guards ────────────────────────────────────────────

describe("token cache", () => {
  it("fetches a token once and reuses it across calls", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org()));
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");
    await kc.getOrganization("kc-org-1");

    expect(tokenCalls()).toHaveLength(1);
    expect(calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-1" });
  });

  it("sends client_credentials with the configured client id/secret to the realm token endpoint", async () => {
    enqueue(() => tokenResponse());
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");

    const token = tokenCalls()[0];
    expect(token?.url).toBe("http://kc.test/realms/givernance/protocol/openid-connect/token");
    const body = new URLSearchParams(String(token?.init.body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("givernance-admin");
    expect(body.get("client_secret")).toBe("sekret");
  });

  it("keeps the cached token just before the 30s safety margin", async () => {
    enqueue(() => tokenResponse({ access_token: "tok-a", expires_in: 60 }));
    enqueue(() => okJson(org()));
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");
    nowMs += 29_000; // expires_in 60s − 30s margin ⇒ stale at +30s, not +29s
    await kc.getOrganization("kc-org-1");

    expect(tokenCalls()).toHaveLength(1);
    expect(calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-a" });
  });

  it("refreshes the token once it crosses the 30s safety margin", async () => {
    enqueue(() => tokenResponse({ access_token: "tok-a", expires_in: 60 }));
    enqueue(() => okJson(org()));
    enqueue(() => tokenResponse({ access_token: "tok-b", expires_in: 60 }));
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");
    nowMs += 31_000;
    await kc.getOrganization("kc-org-1");

    expect(tokenCalls()).toHaveLength(2);
    expect(calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-b" });
  });

  it("clamps the cache TTL to 1s when expires_in is shorter than the 30s margin", async () => {
    // Without the Math.max(…, 1_000) clamp a short-lived token would get a
    // NEGATIVE TTL — silently re-fetching a token on every single request.
    enqueue(() => tokenResponse({ access_token: "tok-short", expires_in: 10 }));
    enqueue(() => okJson(org()));
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");
    nowMs += 500; // within the clamped 1s TTL — must still be cached
    await kc.getOrganization("kc-org-1");

    expect(tokenCalls()).toHaveLength(1);

    enqueue(() => tokenResponse({ access_token: "tok-next", expires_in: 10 }));
    enqueue(() => okJson(org()));
    nowMs += 600; // past the clamped 1s TTL — must re-fetch
    await kc.getOrganization("kc-org-1");
    expect(tokenCalls()).toHaveLength(2);
  });

  it("prefers KEYCLOAK_ADMIN_URL over KEYCLOAK_URL for the admin base", async () => {
    envMock.env.KEYCLOAK_ADMIN_URL = "http://kc-admin.test";
    enqueue(() => tokenResponse());
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");

    expect(tokenCalls()[0]?.url).toContain("http://kc-admin.test/realms/");
    expect(orgCalls()[0]?.url).toBe(
      "http://kc-admin.test/admin/realms/givernance/organizations/kc-org-1",
    );
  });

  it("falls back to KEYCLOAK_INTERNAL_URL when KEYCLOAK_ADMIN_URL is unset", async () => {
    envMock.env.KEYCLOAK_INTERNAL_URL = "http://kc-internal.test";
    enqueue(() => tokenResponse());
    enqueue(() => okJson(org()));

    await kc.getOrganization("kc-org-1");

    expect(tokenCalls()[0]?.url).toContain("http://kc-internal.test/realms/");
    expect(orgCalls()[0]?.url).toBe(
      "http://kc-internal.test/admin/realms/givernance/organizations/kc-org-1",
    );
  });

  it("fails fast when no Keycloak URL is configured (no HTTP call)", async () => {
    envMock.env.KEYCLOAK_URL = undefined;
    await expect(kc.getOrganization("kc-org-1")).rejects.toThrow(/KEYCLOAK_URL/);
    expect(calls).toHaveLength(0);
  });

  it("fails fast when KEYCLOAK_ADMIN_CLIENT_SECRET is missing (no HTTP call)", async () => {
    envMock.env.KEYCLOAK_ADMIN_CLIENT_SECRET = undefined;
    await expect(kc.getOrganization("kc-org-1")).rejects.toThrow(/KEYCLOAK_ADMIN_CLIENT_SECRET/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a token-endpoint failure with the status code", async () => {
    enqueue(() => new Response("nope", { status: 500 }));
    await expect(kc.getOrganization("kc-org-1")).rejects.toThrow(/KC token endpoint returned 500/);
  });
});

// ─── 401 rotation ───────────────────────────────────────────────────────────

describe("admin-API 401 rotation", () => {
  it("re-acquires the token on a 401 and retries the request once with the fresh token", async () => {
    enqueue(() => tokenResponse({ access_token: "tok-stale", expires_in: 300 }));
    enqueue(() => new Response(null, { status: 401 }));
    enqueue(() => tokenResponse({ access_token: "tok-fresh", expires_in: 300 }));
    enqueue(() => okJson(org()));

    const result = await kc.getOrganization("kc-org-1");

    expect(result?.id).toBe("kc-org-1");
    expect(tokenCalls()).toHaveLength(2);
    expect(orgCalls()).toHaveLength(2);
    expect(calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-fresh" });
  });

  it("rotates at most once — a second 401 throws instead of looping", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => new Response(null, { status: 401 }));
    enqueue(() => tokenResponse({ access_token: "tok-2", expires_in: 300 }));
    enqueue(() => new Response(null, { status: 401 }));

    await expect(kc.getOrganization("kc-org-1")).rejects.toThrow(/→ 401/);
    expect(orgCalls()).toHaveLength(2);
  });

  it("re-sends the identical PUT body on the rotated retry and handles its 204", async () => {
    // Pins two prod-critical slices at once: (a) the retry re-serialises the
    // SAME body — a retry that dropped it would replace the whole KC org with
    // an empty document; (b) the 204 guard exists on the retry path too — a
    // rotated retry answering 204 must not explode in retry.json().
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org({ org_slug: ["acme"] })));
    enqueue(() => new Response(null, { status: 401 }));
    enqueue(() => tokenResponse({ access_token: "tok-fresh", expires_in: 300 }));
    enqueue(() => noContent());

    const result = await kc.updateOrganization("kc-org-1", {
      attributes: { logo_url: ["https://cdn.test/x.webp"] },
    });

    expect(result).toEqual({ changed: true });
    const puts = orgCalls().filter((c) => c.init.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(String(puts[1]?.init.body)).toBe(String(puts[0]?.init.body));
    expect(puts[1]?.init.headers).toMatchObject({
      Authorization: "Bearer tok-fresh",
      "Content-Type": "application/json",
    });
  });

  it("treats a 404 on the rotated retry as null (idempotence survives rotation)", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => new Response(null, { status: 401 }));
    enqueue(() => tokenResponse({ access_token: "tok-2", expires_in: 300 }));
    enqueue(() => new Response("gone", { status: 404 }));

    await expect(kc.getOrganization("kc-org-1")).resolves.toBeNull();
  });
});

// ─── 404 idempotence ────────────────────────────────────────────────────────

describe("404 idempotence", () => {
  it("getOrganization returns null on 404 rather than throwing", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => new Response("nope", { status: 404 }));
    await expect(kc.getOrganization("missing")).resolves.toBeNull();
  });

  it("getOrganization throws on other error statuses", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => new Response("boom", { status: 500 }));
    await expect(kc.getOrganization("kc-org-1")).rejects.toThrow(
      /KC admin GET \/organizations\/kc-org-1 → 500/,
    );
  });

  it("percent-encodes the organization id in the path", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org()));

    await kc.getOrganization("a/b?c");

    expect(orgCalls()[0]?.url).toBe(
      "http://kc.test/admin/realms/givernance/organizations/a%2Fb%3Fc",
    );
  });

  it("updateOrganization on a deleted org returns changed:false, skips the PUT, and warns", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => new Response(null, { status: 404 }));

    const result = await kc.updateOrganization("kc-org-gone", {
      attributes: { logo_url: ["https://cdn.test/x.webp"] },
    });

    expect(result).toEqual({ changed: false });
    // Only the token call + the GET — no PUT was issued.
    expect(orgCalls()).toHaveLength(1);
    expect(orgCalls()[0]?.init.method).toBe("GET");
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]?.obj).toMatchObject({ keycloakOrgId: "kc-org-gone" });
  });
});

// ─── GET-then-PUT merge + `changed` semantics ───────────────────────────────

describe("updateOrganization GET-then-PUT merge", () => {
  it("merges updated attributes over the current ones and preserves top-level fields", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() =>
      okJson({
        ...org({ org_slug: ["acme"], logo_url: ["https://cdn.test/old.webp"] }),
        // KC's PUT is a full-document replace: any top-level field the merge
        // drops (instead of spreading `...current`) is destroyed server-side —
        // for `domains`, that means de-verifying the org's email domains.
        domains: [{ name: "acme.org", verified: true }],
      }),
    );
    enqueue(() => noContent());

    const result = await kc.updateOrganization("kc-org-1", {
      attributes: { logo_url: ["https://cdn.test/new.webp"] },
    });

    expect(result).toEqual({ changed: true });
    const put = orgCalls()[1];
    expect(put?.init.method).toBe("PUT");
    expect(put?.url).toBe("http://kc.test/admin/realms/givernance/organizations/kc-org-1");
    expect(JSON.parse(String(put?.init.body))).toEqual({
      id: "kc-org-1",
      name: "Acme NPO",
      alias: "acme",
      domains: [{ name: "acme.org", verified: true }], // spread-preserved, not rebuilt
      attributes: {
        org_slug: ["acme"], // untouched key preserved, not replaced
        logo_url: ["https://cdn.test/new.webp"],
      },
    });
  });

  it("propagates a PUT failure after a successful GET (job must not report success)", async () => {
    // The processor test mocks updateOrganization entirely, so this is the
    // only harness that can catch a swallowed PUT error — which would mark
    // the BullMQ job green while Keycloak never received the write.
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org()));
    enqueue(() => new Response("boom", { status: 500 }));

    await expect(
      kc.updateOrganization("kc-org-1", {
        attributes: { logo_url: ["https://cdn.test/x.webp"] },
      }),
    ).rejects.toThrow(/KC admin PUT \/organizations\/kc-org-1 → 500/);
  });

  it("reports changed:true when the org had no attributes at all", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org()));
    enqueue(() => noContent());

    const result = await kc.updateOrganization("kc-org-1", {
      attributes: { logo_url: ["https://cdn.test/x.webp"] },
    });

    expect(result).toEqual({ changed: true });
    const put = orgCalls()[1];
    expect(JSON.parse(String(put?.init.body)).attributes).toEqual({
      logo_url: ["https://cdn.test/x.webp"],
    });
  });

  it("reports changed:false on an at-least-once re-delivery but STILL issues the PUT", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org({ logo_url: ["https://cdn.test/x.webp"] })));
    enqueue(() => noContent());

    const result = await kc.updateOrganization("kc-org-1", {
      attributes: { logo_url: ["https://cdn.test/x.webp"] },
    });

    // `changed` gates observability emissions (issue #290), NOT the write:
    // idempotent re-PUT stays the safety contract for at-least-once delivery.
    expect(result).toEqual({ changed: false });
    expect(orgCalls()).toHaveLength(2);
    expect(orgCalls()[1]?.init.method).toBe("PUT");
  });
});

// ─── F2 — attribute allowlist guard ─────────────────────────────────────────

describe("Organization attribute allowlist (F2 — JWT leak guard)", () => {
  it("refuses a stranger attribute BEFORE any HTTP call", async () => {
    // No responders enqueued — the guard must throw before fetch fires.
    await expect(
      kc.updateOrganization("kc-org-1", {
        attributes: { secret_token: ["leak-me"] },
      }),
    ).rejects.toThrow(/secret_token/);
    expect(calls).toHaveLength(0);
  });

  it("accepts the allowlisted branding attributes", async () => {
    enqueue(() => tokenResponse({ expires_in: 300 }));
    enqueue(() => okJson(org()));
    enqueue(() => noContent());

    await expect(
      kc.updateOrganization("kc-org-1", {
        attributes: {
          logo_url: ["https://cdn.test/x.webp"],
          theme_primary_color: ["#123456"],
        },
      }),
    ).resolves.toEqual({ changed: true });
  });
});
