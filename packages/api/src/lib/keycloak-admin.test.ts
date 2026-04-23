/**
 * Unit tests for the Keycloak Admin API client (issue #107).
 *
 * Fetch is fully stubbed. Tests exercise:
 *  - token caching + early refresh + refresh on 401
 *  - exponential-backoff retry on 5xx / 429 / network errors
 *  - non-retryable 4xx paths
 *  - circuit breaker (closed → open → half-open transition)
 *  - every public helper (createOrganization, addOrgDomain, attachUserToOrg,
 *    sendInvitation, bindIdpToOrganization, createIdentityProvider, …)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  createKeycloakAdminClient,
  KeycloakAdminError,
} from "./keycloak-admin.js";

type StubCall = { url: string; init: RequestInit };

interface Harness {
  client: ReturnType<typeof createKeycloakAdminClient>;
  calls: StubCall[];
  enqueue: (responder: (call: StubCall) => Response | Promise<Response>) => void;
  advanceTime: (ms: number) => void;
}

function makeHarness(
  overrides: Partial<Parameters<typeof createKeycloakAdminClient>[0]> = {},
): Harness {
  const calls: StubCall[] = [];
  const responders: Array<(call: StubCall) => Response | Promise<Response>> = [];
  let timeMs = 1_000_000;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: StubCall = { url, init: init ?? {} };
    calls.push(call);
    const responder = responders.shift();
    if (!responder) {
      throw new Error(`Unexpected fetch to ${url} — no responder enqueued`);
    }
    return responder(call);
  };

  const client = createKeycloakAdminClient({
    baseUrl: "http://kc.test",
    realm: "givernance",
    clientId: "givernance-admin",
    clientSecret: "sekret",
    fetchImpl,
    nowMs: () => timeMs,
    initialBackoffMs: 1, // keep retry delays tiny in tests
    ...overrides,
  });

  return {
    client,
    calls,
    enqueue: (r) => responders.push(r),
    advanceTime: (ms) => {
      timeMs += ms;
    },
  };
}

const tokenResponse = (body: { access_token?: string; expires_in?: number } = {}): Response =>
  new Response(
    JSON.stringify({
      access_token: body.access_token ?? "tok-1",
      expires_in: body.expires_in ?? 60,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const noContent = (): Response => new Response(null, { status: 204 });

// The harness ships with `initialBackoffMs: 1` so real timers are fine and
// keep tests simple (no need for runAllTimersAsync pump points).

afterEach(() => {
  vi.restoreAllMocks();
});

describe("token cache", () => {
  it("fetches a token once and reuses it across calls", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");
    await h.client.deleteIdentityProvider("two");

    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(h.calls[1]?.init.headers).toMatchObject({ Authorization: "Bearer tok-1" });
  });

  it("refreshes the token when it approaches expiry (30s safety margin)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ access_token: "tok-a", expires_in: 60 }));
    h.enqueue(() => noContent());
    h.enqueue(() => tokenResponse({ access_token: "tok-b", expires_in: 60 }));
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");
    // After the safety-margin elapses, the next call triggers a token refresh.
    h.advanceTime(31_000);
    await h.client.deleteIdentityProvider("two");

    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(h.calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-b" });
  });

  it("re-acquires the token on a 401 response and retries the request", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    // First admin call gets a 401 → client invalidates and retries with a fresh token.
    h.enqueue(() => new Response(null, { status: 401 }));
    h.enqueue(() => tokenResponse({ access_token: "tok-2", expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");

    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(h.calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-2" });
  });
});

describe("retry + non-retryable errors", () => {
  it("retries transient 5xx up to maxAttempts with jittered backoff", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("boom", { status: 502 }));
    h.enqueue(() => new Response("still boom", { status: 503 }));
    h.enqueue(() => noContent());

    await expect(h.client.deleteIdentityProvider("one")).resolves.toBeUndefined();

    const deleteCalls = h.calls.filter((c) => c.init.method === "DELETE");
    expect(deleteCalls).toHaveLength(3);
  });

  it("treats 429 as retryable", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("slow", { status: 429 }));
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");
  });

  it("does NOT retry 4xx (other than 401/429)", async () => {
    const h = makeHarness({ maxAttempts: 5 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("bad", { status: 400 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAdminError);
    const deleteCalls = h.calls.filter((c) => c.init.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
  });

  it("retries a thrown network error and eventually succeeds", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => {
      throw new TypeError("fetch failed");
    });
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");
  });
});

describe("circuit breaker", () => {
  it("opens after `circuitFailureThreshold` consecutive failures, then rejects fast", async () => {
    const h = makeHarness({
      circuitFailureThreshold: 2,
      maxAttempts: 1, // stop retrying inside a single request
    });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 500 }));
    h.enqueue(() => new Response(null, { status: 500 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAdminError);
    await expect(h.client.deleteIdentityProvider("two")).rejects.toBeInstanceOf(KeycloakAdminError);
    expect(h.client._circuitState()).toBe("open");

    // No network call — fails fast.
    await expect(h.client.deleteIdentityProvider("three")).rejects.toBeInstanceOf(CircuitOpenError);
    const nAfter = h.calls.length;
    await expect(h.client.deleteIdentityProvider("four")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(h.calls.length).toBe(nAfter);
  });

  it("moves to half-open after circuitOpenMs and a successful request closes it", async () => {
    const h = makeHarness({ circuitFailureThreshold: 1, maxAttempts: 1, circuitOpenMs: 30_000 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 500 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAdminError);
    expect(h.client._circuitState()).toBe("open");

    h.advanceTime(30_000);
    expect(h.client._circuitState()).toBe("half-open");

    h.enqueue(() => noContent());
    await h.client.deleteIdentityProvider("two");
    expect(h.client._circuitState()).toBe("closed");
  });
});

describe("typed helpers", () => {
  it("createOrganization round-trips through an alias lookup when the POST response is empty", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    // 201 with empty body
    h.enqueue(() => new Response(null, { status: 201 }));
    h.enqueue(() => okJson([{ id: "kc-org-1", name: "NGO France", alias: "ngo-france" }]));

    const org = await h.client.createOrganization({ name: "NGO France", alias: "ngo-france" });
    expect(org).toEqual({ id: "kc-org-1", name: "NGO France", alias: "ngo-france" });
  });

  it("getOrganization returns null on 404 rather than throwing", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("nope", { status: 404 }));
    await expect(h.client.getOrganization("missing")).resolves.toBeNull();
  });

  it("addOrgDomain lowercases the domain and POSTs to /domains", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.addOrgDomain("org-1", "NGO.FR");
    const call = h.calls.at(-1);
    expect(call?.url).toBe("http://kc.test/admin/realms/givernance/organizations/org-1/domains");
    expect(JSON.parse(String(call?.init.body))).toEqual({ name: "ngo.fr", verified: true });
  });

  it("attachUserToOrg, sendInvitation, bindIdpToOrganization hit the right paths", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());

    await h.client.attachUserToOrg("org-1", "user-1");
    await h.client.sendInvitation("org-1", "bob@ngo.fr");
    await h.client.bindIdpToOrganization("org-1", { alias: "entra" });

    const paths = h.calls
      .slice(1)
      .map((c) => c.url.replace("http://kc.test/admin/realms/givernance", ""));
    expect(paths).toEqual([
      "/organizations/org-1/members",
      "/organizations/org-1/members/invite-user",
      "/organizations/org-1/identity-providers",
    ]);
  });

  it("createIdentityProvider + deleteIdentityProvider hit /identity-provider/instances", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());

    await h.client.createIdentityProvider({
      alias: "entra",
      providerId: "oidc",
      config: { clientId: "abc" },
    });
    await h.client.deleteIdentityProvider("entra");

    const body = JSON.parse(String(h.calls[1]?.init.body));
    expect(body).toMatchObject({ alias: "entra", providerId: "oidc", enabled: true });
    expect(h.calls[2]?.init.method).toBe("DELETE");
    expect(h.calls[2]?.url).toContain("/identity-provider/instances/entra");
  });
});
