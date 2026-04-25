/**
 * Unit tests for the Keycloak Admin API client (issue #107).
 *
 * Fetch + clock + random are all injected so the suite is fully
 * deterministic and CI-stable. Covers:
 *  - token caching, expiry refresh with 30s margin, 401 rotation,
 *    bad-secret 401/403 are non-retryable, in-flight dedup on cold cache.
 *  - retry semantics: 5xx retried on GET/PUT/DELETE, POST not retried on
 *    5xx (duplicate-side-effect safety), 429 retried everywhere, network
 *    retried on idempotent methods, JSON-parse errors not retried.
 *  - circuit breaker: closed → open, fail-fast, half-open single probe,
 *    half-open failure re-arms timer (stays "open"), success closes.
 *  - every public helper: method / URL / body shape.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetKeycloakAdminSingleton,
  CircuitOpenError,
  createKeycloakAdminClient,
  KeycloakAdminError,
  KeycloakAuthError,
  KeycloakUserExistsError,
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
    randomImpl: () => 0, // deterministic jitter
    initialBackoffMs: 1,
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

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const noContent = (): Response => new Response(null, { status: 204 });

const created = (locationId: string): Response =>
  new Response(null, {
    status: 201,
    headers: { Location: `http://kc.test/admin/realms/givernance/organizations/${locationId}` },
  });

afterEach(() => {
  vi.restoreAllMocks();
  _resetKeycloakAdminSingleton();
});

// ─── Token cache ────────────────────────────────────────────────────────────

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
    h.advanceTime(31_000);
    await h.client.deleteIdentityProvider("two");

    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(h.calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-b" });
  });

  it("re-acquires the token on an admin-API 401 and retries the request", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 401 }));
    h.enqueue(() => tokenResponse({ access_token: "tok-2", expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");

    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(h.calls.at(-1)?.init.headers).toMatchObject({ Authorization: "Bearer tok-2" });
  });

  it("treats a 401 at the token endpoint as non-retryable (bad secret)", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => new Response("bad secret", { status: 401 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAuthError);
    // No retries — only one fetch to /token.
    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("dedupes in-flight token fetches when multiple callers race on a cold cache", async () => {
    const h = makeHarness();
    h.enqueue(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(tokenResponse({ expires_in: 300 })), 5),
        ),
    );
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());

    await Promise.all([
      h.client.deleteIdentityProvider("a"),
      h.client.deleteIdentityProvider("b"),
      h.client.deleteIdentityProvider("c"),
    ]);

    const tokenCalls = h.calls.filter((c) => c.url.includes("/protocol/openid-connect/token"));
    expect(tokenCalls).toHaveLength(1);
  });
});

// ─── Retry + non-retryable errors ───────────────────────────────────────────

describe("retry + non-retryable errors", () => {
  it("retries transient 5xx on idempotent methods (DELETE)", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("boom", { status: 502 }));
    h.enqueue(() => new Response("still boom", { status: 503 }));
    h.enqueue(() => noContent());

    await expect(h.client.deleteIdentityProvider("one")).resolves.toBeUndefined();
    const deleteCalls = h.calls.filter((c) => c.init.method === "DELETE");
    expect(deleteCalls).toHaveLength(3);
  });

  it("does NOT retry 5xx on POST (non-idempotent writes)", async () => {
    const h = makeHarness({ maxAttempts: 5 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 502 }));

    await expect(h.client.attachUserToOrg("org-1", "user-1")).rejects.toBeInstanceOf(
      KeycloakAdminError,
    );

    const postCalls = h.calls.filter((c) => c.init.method === "POST" && c.url.includes("/members"));
    expect(postCalls).toHaveLength(1);
  });

  it("retries 429 on POST (rate-limit is safe to retry)", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 429 }));
    h.enqueue(() => noContent());

    await h.client.attachUserToOrg("org-1", "user-1");
  });

  it("does NOT retry 4xx (other than 401/429)", async () => {
    const h = makeHarness({ maxAttempts: 5 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("bad", { status: 400 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAdminError);
    const deleteCalls = h.calls.filter((c) => c.init.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
  });

  it("does NOT retry a JSON parse failure on 200", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(
      () => new Response("not-json", { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    await expect(h.client.getOrganization("id-1")).rejects.toBeInstanceOf(SyntaxError);
    const getCalls = h.calls.filter((c) => c.init.method === "GET");
    expect(getCalls).toHaveLength(1);
  });

  it("retries a thrown network error on idempotent methods and eventually succeeds", async () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => {
      throw new TypeError("fetch failed");
    });
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("one");
  });

  it("throws the last error after exhausting retries", async () => {
    const h = makeHarness({ maxAttempts: 2 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("bad-gateway", { status: 502 }));
    h.enqueue(() => new Response("still-bad", { status: 503 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toMatchObject({
      name: "KeycloakAdminError",
      status: 503,
    });
    const deleteCalls = h.calls.filter((c) => c.init.method === "DELETE");
    expect(deleteCalls).toHaveLength(2);
  });
});

// ─── Circuit breaker ────────────────────────────────────────────────────────

describe("circuit breaker", () => {
  it("opens after `circuitFailureThreshold` consecutive 5xx failures, then rejects fast", async () => {
    const h = makeHarness({
      circuitFailureThreshold: 2,
      maxAttempts: 1,
    });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 500 }));
    h.enqueue(() => new Response(null, { status: 500 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAdminError);
    await expect(h.client.deleteIdentityProvider("two")).rejects.toBeInstanceOf(KeycloakAdminError);
    expect(h.client._circuitState()).toBe("open");

    const nBefore = h.calls.length;
    await expect(h.client.deleteIdentityProvider("three")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(h.calls.length).toBe(nBefore);
  });

  it("does NOT count client 4xx toward the breaker", async () => {
    const h = makeHarness({ circuitFailureThreshold: 2, maxAttempts: 1 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("not found", { status: 404 }));
    h.enqueue(() => new Response("nope", { status: 404 }));
    h.enqueue(() => new Response("still nope", { status: 404 }));

    for (const id of ["a", "b", "c"]) {
      await expect(h.client.getOrganization(id)).resolves.toBeNull();
    }
    expect(h.client._circuitState()).toBe("closed");
  });

  it("moves to half-open after circuitOpenMs and a successful probe closes it", async () => {
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

  it("failed half-open probe re-arms the timer (stays in 'open')", async () => {
    const h = makeHarness({ circuitFailureThreshold: 1, maxAttempts: 1, circuitOpenMs: 30_000 });
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 500 }));

    await expect(h.client.deleteIdentityProvider("one")).rejects.toBeInstanceOf(KeycloakAdminError);
    h.advanceTime(30_000);

    h.enqueue(() => new Response(null, { status: 500 }));
    await expect(h.client.deleteIdentityProvider("two")).rejects.toBeInstanceOf(KeycloakAdminError);
    expect(h.client._circuitState()).toBe("open");
    // Immediately afterwards, the breaker must reject additional calls fast.
    const nBefore = h.calls.length;
    await expect(h.client.deleteIdentityProvider("three")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(h.calls.length).toBe(nBefore);
  });
});

// ─── Typed helpers ──────────────────────────────────────────────────────────

describe("typed helpers", () => {
  it("createOrganization follows the Location header (not an alias search)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => created("kc-org-42"));
    h.enqueue(() => okJson({ id: "kc-org-42", name: "NGO France", alias: "ngo-france" }));

    const org = await h.client.createOrganization({ name: "NGO France", alias: "ngo-france" });
    expect(org).toEqual({ id: "kc-org-42", name: "NGO France", alias: "ngo-france" });
    // The follow-up GET uses the ID from Location, not a search.
    expect(h.calls.at(-1)?.url).toBe(
      "http://kc.test/admin/realms/givernance/organizations/kc-org-42",
    );
  });

  it("createOrganization returns the body directly when the POST response has a body", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => okJson({ id: "kc-org-1", name: "NGO", alias: "ngo" }, 201));

    const org = await h.client.createOrganization({ name: "NGO", alias: "ngo" });
    expect(org).toMatchObject({ id: "kc-org-1", alias: "ngo" });
  });

  it("getOrganization returns null on 404 rather than throwing", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("nope", { status: 404 }));
    await expect(h.client.getOrganization("missing")).resolves.toBeNull();
  });

  it("deleteOrganization hits DELETE /organizations/:id", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.deleteOrganization("org-1");
    expect(h.calls.at(-1)?.url).toBe("http://kc.test/admin/realms/givernance/organizations/org-1");
    expect(h.calls.at(-1)?.init.method).toBe("DELETE");
  });

  it("addOrgDomain lowercases the domain and requires an explicit `verified` flag", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.addOrgDomain("org-1", "NGO.FR", { verified: false });
    const call = h.calls.at(-1);
    expect(call?.url).toBe("http://kc.test/admin/realms/givernance/organizations/org-1/domains");
    expect(JSON.parse(String(call?.init.body))).toEqual({ name: "ngo.fr", verified: false });
  });

  it("attachUserToOrg, sendInvitation, bindIdpToOrganization send the right bodies", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());
    h.enqueue(() => noContent());

    await h.client.attachUserToOrg("org-1", "user-1");
    await h.client.sendInvitation("org-1", "bob@ngo.fr");
    await h.client.bindIdpToOrganization("org-1", { alias: "entra" });

    // Canonical KC 26 member-add body is a raw JSON string (quoted user id),
    // not an object. See keycloak-admin.ts:attachUserToOrg for rationale.
    expect(JSON.parse(String(h.calls[1]?.init.body))).toEqual("user-1");
    expect(JSON.parse(String(h.calls[2]?.init.body))).toEqual({ email: "bob@ngo.fr" });
    expect(JSON.parse(String(h.calls[3]?.init.body))).toEqual({ alias: "entra" });
  });

  it("percent-encodes path parameters", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.deleteIdentityProvider("ent/ra?bad#slashes");

    const call = h.calls.at(-1);
    expect(call?.url).toBe(
      "http://kc.test/admin/realms/givernance/identity-provider/instances/ent%2Fra%3Fbad%23slashes",
    );
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

// ─── User / Organization helpers added in PR #143 ───────────────────────────

const createdUser = (locationId: string): Response =>
  new Response(null, {
    status: 201,
    headers: { Location: `http://kc.test/admin/realms/givernance/users/${locationId}` },
  });

describe("createUser", () => {
  it("POSTs to /users with username=email, normalises case, sets non-temporary credential, passes attributes", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => createdUser("kc-user-uuid"));

    const result = await h.client.createUser({
      email: "  Alice@Example.org  ",
      firstName: "Alice",
      lastName: "Anderson",
      password: "verify-12-chars",
      emailVerified: true,
      attributes: { org_id: ["tenant-uuid"], role: ["org_admin"] },
    });

    expect(result).toEqual({ id: "kc-user-uuid" });
    const create = h.calls[1];
    expect(create?.url).toBe("http://kc.test/admin/realms/givernance/users");
    expect(create?.init.method).toBe("POST");
    const body = JSON.parse(String(create?.init.body));
    expect(body).toEqual({
      username: "alice@example.org",
      email: "alice@example.org",
      firstName: "Alice",
      lastName: "Anderson",
      enabled: true,
      emailVerified: true,
      credentials: [{ type: "password", value: "verify-12-chars", temporary: false }],
      attributes: { org_id: ["tenant-uuid"], role: ["org_admin"] },
    });
  });

  it("omits the attributes field when no attributes are provided", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => createdUser("kc-user-uuid-2"));

    await h.client.createUser({
      email: "bob@example.org",
      firstName: "Bob",
      lastName: "B",
      password: "verify-12-chars",
    });

    const body = JSON.parse(String(h.calls[1]?.init.body));
    expect(body).not.toHaveProperty("attributes");
    expect(body.emailVerified).toBe(false);
  });

  it("throws KeycloakUserExistsError on 409 — does NOT silently take over the existing realm user", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response("conflict", { status: 409 }));

    await expect(
      h.client.createUser({
        email: "victim@example.org",
        firstName: "V",
        lastName: "I",
        password: "verify-12-chars",
        attributes: { org_id: ["attacker-tenant"] },
      }),
    ).rejects.toBeInstanceOf(KeycloakUserExistsError);

    // Critical: NO follow-up GET /users?email= or PUT /reset-password.
    // The 409 must be terminal — only token call + the failing POST.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.init.method).toBe("POST");
  });

  it("throws if the response has no body and no Location header (KC misbehaves)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 201 })); // no Location

    await expect(
      h.client.createUser({
        email: "n@b.com",
        firstName: "N",
        lastName: "B",
        password: "verify-12-chars",
      }),
    ).rejects.toBeInstanceOf(KeycloakAdminError);
  });

  it("never logs the password (request body is not logged by the admin client)", async () => {
    // The admin client logs only `{method, path, status, latencyMs, attempt}`
    // — it does NOT pass the request body to pino. We assert that property
    // by spying on console.* (pino's transport in tests) and grepping for
    // the literal password value across every emitted line.
    const seen: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      seen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const h = makeHarness();
      h.enqueue(() => tokenResponse({ expires_in: 300 }));
      h.enqueue(() => createdUser("kc-user-redact"));

      await h.client.createUser({
        email: "redact@example.org",
        firstName: "R",
        lastName: "E",
        password: "extremely-secret-pw-123",
      });
    } finally {
      process.stdout.write = origStdoutWrite;
    }
    expect(seen.join("")).not.toContain("extremely-secret-pw-123");
  });
});

describe("resetUserPassword", () => {
  it("PUTs the non-temporary password credential to /users/{id}/reset-password", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.resetUserPassword("user-uuid", "new-secret-123");

    const call = h.calls[1];
    expect(call?.url).toBe("http://kc.test/admin/realms/givernance/users/user-uuid/reset-password");
    expect(call?.init.method).toBe("PUT");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      type: "password",
      value: "new-secret-123",
      temporary: false,
    });
  });

  it("percent-encodes the user id in the path", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => noContent());

    await h.client.resetUserPassword("a/b?c", "pw");
    expect(h.calls[1]?.url).toBe(
      "http://kc.test/admin/realms/givernance/users/a%2Fb%3Fc/reset-password",
    );
  });
});

describe("setUserAttributes", () => {
  it("GETs the user, merges attributes, PUTs the full body back (preserves email/firstName/etc.)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() =>
      okJson({
        id: "user-uuid",
        email: "alice@example.org",
        firstName: "Alice",
        lastName: "Anderson",
        emailVerified: true,
        attributes: { existing: ["keep-me"] },
      }),
    );
    h.enqueue(() => noContent());

    await h.client.setUserAttributes("user-uuid", { org_id: ["tenant-uuid"] });

    const get = h.calls[1];
    const put = h.calls[2];
    expect(get?.init.method ?? "GET").toBe("GET");
    expect(get?.url).toBe("http://kc.test/admin/realms/givernance/users/user-uuid");
    expect(put?.init.method).toBe("PUT");
    expect(put?.url).toBe("http://kc.test/admin/realms/givernance/users/user-uuid");
    const body = JSON.parse(String(put?.init.body));
    // Untouched fields preserved.
    expect(body.email).toBe("alice@example.org");
    expect(body.firstName).toBe("Alice");
    expect(body.emailVerified).toBe(true);
    // Attributes merged, not replaced.
    expect(body.attributes).toEqual({
      existing: ["keep-me"],
      org_id: ["tenant-uuid"],
    });
  });

  it("throws KeycloakAdminError when the user is not found (404 on GET)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => new Response(null, { status: 404 }));

    await expect(h.client.setUserAttributes("missing", { org_id: ["x"] })).rejects.toBeInstanceOf(
      KeycloakAdminError,
    );
  });
});

describe("getOrganizationByAlias", () => {
  it("GETs /organizations?search=alias and returns the EXACT-alias match (filters substring matches client-side)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() =>
      okJson([
        // Substring-match drift — KC's `search` does substring matching, so
        // a query for `acme` returns both. The client MUST pick the exact one.
        { id: "org-foundation", name: "Acme Foundation", alias: "acme-foundation" },
        { id: "org-acme", name: "Acme", alias: "acme" },
      ]),
    );

    const result = await h.client.getOrganizationByAlias("acme");
    expect(result?.id).toBe("org-acme");
    expect(h.calls[1]?.url).toBe(
      "http://kc.test/admin/realms/givernance/organizations?search=acme",
    );
  });

  it("returns null when no exact alias matches (substring matches alone don't qualify)", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() =>
      okJson([{ id: "org-foundation", name: "Acme Foundation", alias: "acme-foundation" }]),
    );

    expect(await h.client.getOrganizationByAlias("acme")).toBeNull();
  });

  it("normalises the alias (trim + lowercase) before matching", async () => {
    const h = makeHarness();
    h.enqueue(() => tokenResponse({ expires_in: 300 }));
    h.enqueue(() => okJson([{ id: "org-acme", name: "Acme", alias: "acme" }]));

    const result = await h.client.getOrganizationByAlias("  ACME  ");
    expect(result?.id).toBe("org-acme");
  });
});
