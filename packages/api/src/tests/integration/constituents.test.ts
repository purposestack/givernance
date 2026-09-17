import { randomUUID } from "node:crypto";
import {
  bankAccounts,
  campaignConstituents,
  campaignDocuments,
  campaignQrCodes,
  campaigns,
  constituents,
  donations,
  pledges,
  swissQrReferences,
} from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeConstituents } from "../../modules/constituents/service.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  seedTenantUser,
  signToken,
  signTokenB,
  USER_A,
} from "../helpers/auth.js";
import { db, withTenantContext } from "../helpers/db.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await app.close();
});

// ─── CRUD Operations ────────────────────────────────────────────────────────

describe("Constituents CRUD", () => {
  let constituentId: string;

  it("POST /v1/constituents creates a constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Alice",
        lastName: "Dupont",
        email: "alice@example.org",
        type: "donor",
        tags: ["major-donor", "annual"],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; firstName: string } }>();
    expect(body.data).toHaveProperty("id");
    expect(body.data.firstName).toBe("Alice");
    constituentId = body.data.id;
  });

  it("GET /v1/constituents/:id returns the constituent with activities stub", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; activities: unknown[] } }>();
    expect(body.data.id).toBe(constituentId);
    expect(body.data.activities).toEqual([]);
  });

  it("PUT /v1/constituents/:id updates the constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { lastName: "Martin" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { lastName: string } }>();
    expect(body.data.lastName).toBe("Martin");
  });

  // Regression: the edit form used to drop empty optional fields, which
  // meant operators couldn't ever delete a previously-set phone or email.
  // Convention is now: `null` = explicit clear, omitted = leave alone.
  it("PUT /v1/constituents/:id with phone:null clears a previously-set phone", async () => {
    const tokenA = signToken(app);
    // Seed a phone first.
    const seed = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { phone: "+33 6 12 34 56 78" },
    });
    expect(seed.statusCode).toBe(200);
    expect(seed.json<{ data: { phone: string } }>().data.phone).toBe("+33 6 12 34 56 78");

    // Clear it via explicit null.
    const cleared = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { phone: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ data: { phone: string | null } }>().data.phone).toBeNull();

    // Sanity: omitting the field DOES leave it alone (would re-set if the
    // server treated empty payload the same as null).
    const reSeed = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { phone: "+33 1 11 22 33 44" },
    });
    expect(reSeed.statusCode).toBe(200);
    const noTouch = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { lastName: "PhoneSurvivor" },
    });
    expect(noTouch.statusCode).toBe(200);
    expect(noTouch.json<{ data: { phone: string | null } }>().data.phone).toBe("+33 1 11 22 33 44");
  });

  it("PUT /v1/constituents/:id with email:null clears a previously-set email", async () => {
    const tokenA = signToken(app);
    const cleared = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { email: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ data: { email: string | null } }>().data.email).toBeNull();
  });

  it("GET /v1/constituents/:id returns 404 for non-existent ID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/constituents/:id returns 400 for invalid UUID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/not-a-valid-uuid",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(400);
  });

  it("PUT /v1/constituents/:id returns 404 for non-existent ID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/constituents/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(tokenA),
      payload: { firstName: "Ghost" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("PUT /v1/constituents/:id returns 400 for invalid UUID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/constituents/not-a-valid-uuid",
      headers: authHeader(tokenA),
      payload: { firstName: "Ghost" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("DELETE /v1/constituents/:id soft-deletes the constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deletedAt: string } }>();
    expect(body.data.deletedAt).toBeTruthy();
  });

  it("GET /v1/constituents/:id returns 404 after soft-delete", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("DELETE /v1/constituents/:id returns 404 for already-deleted constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Search and Filtering ───────────────────────────────────────────────────

describe("Constituents search and filtering", () => {
  beforeAll(async () => {
    const tokenA = signToken(app);
    const entries = [
      {
        firstName: "Marie",
        lastName: "Curie",
        email: "marie@science.org",
        type: "donor",
        tags: ["vip"],
      },
      {
        firstName: "Pierre",
        lastName: "Curie",
        email: "pierre@science.org",
        type: "volunteer",
        tags: ["vip", "board"],
      },
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@tech.org",
        type: "member",
        tags: ["board"],
      },
    ];

    for (const entry of entries) {
      await app.inject({
        method: "POST",
        url: "/v1/constituents?force=true",
        headers: authHeader(tokenA),
        payload: entry,
      });
    }
  });

  it("search by name returns matching constituents", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=Curie",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { lastName: string }[]; pagination: { total: number } }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const c of body.data) {
      expect(c.lastName).toBe("Curie");
    }
  });

  it("search with trailing whitespace is trimmed (does not return empty)", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=Curie%20",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("multi-token search ANDs tokens across firstName/lastName/email", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=Marie%20Curie",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { firstName: string; lastName: string }[];
    }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.some((c) => c.firstName === "Marie" && c.lastName === "Curie")).toBe(true);
  });

  it("search by email returns matching constituents", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=ada@tech",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filter by type returns only matching type", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?type=volunteer",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { type: string }[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const c of body.data) {
      expect(c.type).toBe("volunteer");
    }
  });

  it("filter by tags returns constituents with matching tags", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?tags=board",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { tags: string[] }[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("soft-deleted constituents are excluded by default", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deletedAt: string | null }[] }>();
    for (const c of body.data) {
      expect(c.deletedAt).toBeNull();
    }
  });
});

// ─── RLS Tenant Isolation ───────────────────────────────────────────────────

describe("Constituents RLS tenant isolation", () => {
  let constituentInA: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "TenantAIsolation", lastName: "Only", type: "donor" },
    });
    constituentInA = res.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant B cannot GET a constituent from Tenant A", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${constituentInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot PUT a constituent from Tenant A", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentInA}`,
      headers: authHeader(tokenB),
      payload: { firstName: "Hacked" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot DELETE a constituent from Tenant A", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B list does not include Tenant A constituents", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string }[] }>();
    const ids = body.data.map((c) => c.id);
    expect(ids).not.toContain(constituentInA);
  });
});

// ─── Unauthenticated Access ─────────────────────────────────────────────────

describe("Constituents unauthenticated access", () => {
  it("GET /v1/constituents/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(401);
  });

  it("PUT /v1/constituents/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
      payload: { firstName: "Test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /v1/constituents/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /v1/constituents/:id requires org_admin (returns 403 for user role)", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Viewer-role write blocking (issue #162) ───────────────────────────────
//
// Regression coverage for the original symptom: a `viewer` JWT should never
// be able to mutate constituent state, nor surface duplicate-search results
// (the search is a pre-flight to create — useless to a role that can't
// follow through).

describe("Constituents viewer-role enforcement (issue #162)", () => {
  it("POST /v1/constituents returns 403 for viewer role with RFC 9457 problem body", async () => {
    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(viewerToken),
      payload: {
        firstName: "Viewer",
        lastName: "Blocked",
        type: "donor",
      },
    });
    expect(res.statusCode).toBe(403);
    // Lock the RFC 9457 body shape on at least one viewer-403 path so a
    // future regression that returns `{ error: "..." }` (or strips the
    // `type` URI) breaks here, not in unrelated SDK / web parsing.
    const body = res.json<{ type: string; title: string; status: number; detail: string }>();
    expect(body.type).toBe("https://httpproblems.com/http-status/403");
    expect(body.title).toBe("Forbidden");
    expect(body.status).toBe(403);
    expect(body.detail).toMatch(/write access required/i);
  });

  it("PUT /v1/constituents/:id returns 403 for viewer role", async () => {
    // Seed via admin so a target row exists.
    const tokenA = signToken(app);
    const seed = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "ViewerTarget", lastName: "Untouched", type: "donor" },
    });
    const targetId = seed.json<{ data: { id: string } }>().data.id;

    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${targetId}`,
      headers: authHeader(viewerToken),
      payload: { firstName: "Hacked" },
    });
    expect(res.statusCode).toBe(403);

    // Sanity: the row was not touched.
    const check = await app.inject({
      method: "GET",
      url: `/v1/constituents/${targetId}`,
      headers: authHeader(tokenA),
    });
    expect(check.json<{ data: { firstName: string } }>().data.firstName).toBe("ViewerTarget");
  });

  it("GET /v1/constituents/duplicates/search returns 403 for viewer role", async () => {
    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/duplicates/search?firstName=Anyone&lastName=Anywhere",
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE /v1/constituents/:id returns 403 for viewer role", async () => {
    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/constituents stays accessible to viewer (read-only)", async () => {
    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/constituents supports search filter", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=Jane",
      headers: authHeader(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeInstanceOf(Array);
    // As long as the query succeeds, backend ilike logic didn't crash.
  });

  it("user role can still POST /v1/constituents (parity with org_admin)", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(userToken),
      payload: { firstName: "User", lastName: "Allowed", type: "donor" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("user role can still PUT /v1/constituents/:id", async () => {
    // Seed via admin so a target exists, then update as `user`.
    const tokenA = signToken(app);
    const seed = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "UserPut", lastName: "Target", type: "donor" },
    });
    const id = seed.json<{ data: { id: string } }>().data.id;

    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${id}`,
      headers: authHeader(userToken),
      payload: { firstName: "Edited" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("user role can still GET /v1/constituents/duplicates/search", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/duplicates/search?firstName=Anyone&lastName=Anywhere",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(200);
  });

  // Issue #616 — soft-deleted rows (merged duplicates, erasure candidates)
  // are an org_admin-only view; the plain list stays open to every role.
  it.each([
    ["viewer", 403],
    ["user", 403],
    ["org_admin", 200],
  ] as const)("GET /v1/constituents?includeDeleted=true as %s → %i", async (role, expected) => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?includeDeleted=true",
      headers: authHeader(signToken(app, { role })),
    });
    expect(res.statusCode).toBe(expected);

    const plain = await app.inject({
      method: "GET",
      url: "/v1/constituents?includeDeleted=false",
      headers: authHeader(signToken(app, { role })),
    });
    expect(plain.statusCode).toBe(200);
  });

  // Sanity: tightening writes mustn't over-block reads. If a future change
  // mass-replaces `requireAuth` → `requireWrite` (an easy mistake in the
  // donations follow-up #176), this test will catch it for constituents.
  it("GET /v1/constituents/:id stays accessible to viewer (read-only)", async () => {
    const tokenA = signToken(app);
    const seed = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "ReadMe", lastName: "AsViewer", type: "donor" },
    });
    const id = seed.json<{ data: { id: string } }>().data.id;

    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${id}`,
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Duplicate Detection ──────────────────────────────────────────────────────

describe("Constituents duplicate detection", () => {
  const uniqueSuffix = Date.now().toString(36);
  const dedupFirst = `Zdravko${uniqueSuffix}`;
  const dedupLast = `Petrovic${uniqueSuffix}`;
  const dedupEmail = `zdravko.${uniqueSuffix}@example.org`;
  let dedupId: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: dedupFirst,
        lastName: dedupLast,
        email: dedupEmail,
        type: "donor",
      },
    });
    dedupId = res.json<{ data: { id: string } }>().data.id;
  });

  it("GET /v1/constituents/duplicates/search finds similar names", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/duplicates/search?firstName=${dedupFirst}&lastName=${dedupLast}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; score: number }[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const match = body.data.find((d) => d.id === dedupId);
    expect(match).toBeTruthy();
    expect(match?.score).toBeGreaterThanOrEqual(0.3);
  });

  it("GET /v1/constituents/duplicates/search finds exact email match", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/duplicates/search?firstName=Z&lastName=P&email=${dedupEmail}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; score: number }[] }>();
    const match = body.data.find((d) => d.id === dedupId);
    expect(match).toBeTruthy();
  });

  it("POST /v1/constituents returns 409 when duplicate detected", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents",
      headers: authHeader(tokenA),
      payload: {
        firstName: dedupFirst,
        lastName: dedupLast,
        email: dedupEmail,
        type: "donor",
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ duplicates: { id: string }[] }>();
    expect(body.duplicates.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /v1/constituents?force=true bypasses duplicate check", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: dedupFirst,
        lastName: dedupLast,
        email: `force.${uniqueSuffix}@example.org`,
        type: "donor",
      },
    });

    expect(res.statusCode).toBe(201);
  });

  // Issue #616 — the gate used to sit below a single name component's
  // weight, so any shared first OR last name 409'd.
  describe("threshold — one shared name component is not a duplicate", () => {
    // Fully random, letters-only family names ("Jean Dupont" / "Marie Dupont"
    // in spirit): a fixed stem would make this run's rows look like
    // duplicates of a previous run's leftovers in the shared test database.
    const randomName = () =>
      `X${Array.from({ length: 9 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`;
    const family = randomName();
    const otherFamily = randomName();
    const email = `anselme.${family.toLowerCase()}@example.org`;
    const createdIds: string[] = [];
    let existingId: string;

    async function create(payload: Record<string, unknown>) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/constituents",
        headers: authHeader(signToken(app)),
        payload: { type: "donor", ...payload },
      });
      if (res.statusCode === 201) createdIds.push(res.json<{ data: { id: string } }>().data.id);
      return res;
    }

    beforeAll(async () => {
      const res = await create({ firstName: "Anselme", lastName: family, email });
      expect(res.statusCode).toBe(201);
      existingId = res.json<{ data: { id: string } }>().data.id;
    });

    afterAll(async () => {
      // Soft-delete: keeps later runs' first names from pairing with these rows.
      await db
        .update(constituents)
        .set({ deletedAt: new Date() })
        .where(and(eq(constituents.orgId, ORG_A), inArray(constituents.id, createdIds)));
    });

    it("same last name, different first name → created (no 409)", async () => {
      const res = await create({ firstName: "Odile", lastName: family });
      expect(res.statusCode).toBe(201);
    });

    it("same first name, different last name → created (no 409)", async () => {
      const res = await create({ firstName: "Anselme", lastName: otherFamily });
      expect(res.statusCode).toBe(201);
    });

    it("near-identical full name (one-letter typo) → 409 naming the existing record", async () => {
      const typo = `${family.slice(0, -1)}${family.endsWith("q") ? "r" : "q"}`;
      const res = await create({ firstName: "Anselme", lastName: typo });
      expect(res.statusCode).toBe(409);
      const ids = res.json<{ duplicates: { id: string }[] }>().duplicates.map((d) => d.id);
      expect(ids).toContain(existingId);
    });

    it("same email, completely different name → 409", async () => {
      const res = await create({ firstName: "Zoé", lastName: "Quatremère", email });
      expect(res.statusCode).toBe(409);
      const ids = res.json<{ duplicates: { id: string }[] }>().duplicates.map((d) => d.id);
      expect(ids).toContain(existingId);
    });
  });
});

// ─── Merge ────────────────────────────────────────────────────────────────────

describe("Constituents merge", () => {
  let primaryId: string;
  let duplicateId: string;
  let donationId: string;

  beforeAll(async () => {
    const tokenA = signToken(app);

    // Create primary constituent (has phone, no email)
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Marie",
        lastName: "Mergeable",
        phone: "+33123456789",
        type: "donor",
        tags: ["annual"],
      },
    });
    primaryId = res1.json<{ data: { id: string } }>().data.id;

    // Create duplicate constituent (has email, no phone)
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Marie",
        lastName: "Mergeable",
        email: "marie@merge.org",
        type: "donor",
        tags: ["vip"],
      },
    });
    duplicateId = res2.json<{ data: { id: string } }>().data.id;

    // Create a donation linked to the duplicate (use withTenantContext, not session-scoped set_config)
    await withTenantContext(ORG_A, async (tx) => {
      const [don] = await tx
        .insert(donations)
        .values({
          orgId: ORG_A,
          constituentId: duplicateId,
          amountCents: 5000,
          currency: "EUR",
          exchangeRate: "1",
          amountBaseCents: 5000,
        })
        .returning();
      donationId = don!.id;
    });
  });

  it("POST /v1/constituents/:id/merge merges duplicate into primary", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: duplicateId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { merged: boolean } }>().data.merged).toBe(true);
  });

  it("primary constituent has merged fields from duplicate", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${primaryId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: { email: string; phone: string; tags: string[] };
    }>().data;
    expect(data.email).toBe("marie@merge.org");
    expect(data.phone).toBe("+33123456789");
    expect(data.tags).toContain("annual");
    expect(data.tags).toContain("vip");
  });

  it("duplicate constituent is soft-deleted after merge", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${duplicateId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("donations are moved to primary constituent", async () => {
    await withTenantContext(ORG_A, async (tx) => {
      const rows = await tx.select().from(donations).where(sql`id = ${donationId}`);
      expect(rows.length).toBe(1);
      expect(rows[0]!.constituentId).toBe(primaryId);
    });
  });

  it("outbox events are emitted for merge with correct payload", async () => {
    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A}
            AND type IN ('constituent.merged', 'constituent.deleted')
          ORDER BY created_at DESC LIMIT 2`,
    );

    const types = rows.rows.map((r) => (r as { type: string }).type);
    expect(types).toContain("constituent.merged");
    expect(types).toContain("constituent.deleted");

    // Verify merged event payload contains double-attribution data
    const mergedEvent = rows.rows.find(
      (r) => (r as { type: string }).type === "constituent.merged",
    ) as { payload: Record<string, unknown> } | undefined;
    expect(mergedEvent).toBeTruthy();
    expect(mergedEvent?.payload).toHaveProperty("survivorId");
    expect(mergedEvent?.payload).toHaveProperty("mergedId");
    expect(mergedEvent?.payload).toHaveProperty("mergedBy");
  });

  it("returns 400 when merging a constituent into itself", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: primaryId },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when one of the constituents does not exist", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: "00000000-0000-0000-0000-ffffffffffff" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/constituents/:id/merge returns 400 for invalid UUID in targetId", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: "not-a-valid-uuid" },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── Merge re-pointing (issue #616) ─────────────────────────────────────────
//
// The merge used to move donations only: pledges, campaign membership,
// letters and QR / payment references stayed on the soft-deleted duplicate.
// Runs in a dedicated tenant so the bank-account / export fixtures never
// interfere with the suites that own ORG_A.

describe("Constituents merge — re-points every dependent row (issue #616)", () => {
  const orgId = randomUUID();
  const sub = randomUUID();
  let token: string;

  async function createConstituent(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(token),
      payload: { type: "donor", ...payload },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ data: { id: string } }>().data.id;
  }

  async function getRow(id: string) {
    const [row] = await db
      .select()
      .from(constituents)
      .where(and(eq(constituents.orgId, orgId), eq(constituents.id, id)));
    return row;
  }

  beforeAll(async () => {
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug) VALUES (${orgId}, 'Merge Repoint Org', ${`merge-${orgId.slice(0, 8)}`})`,
    );
    await seedTenantUser(orgId, { sub });
    token = signToken(app, { sub, org_id: orgId, email: `test-${sub}@example.org` });
  });

  afterAll(async () => {
    // Replica role: skips the audit_logs immutability trigger and the
    // bank-account RESTRICT FK so the fixture tenant can be removed whole.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      for (const table of [
        "swiss_qr_references",
        "campaign_qr_codes",
        "campaign_documents",
        "campaign_constituents",
        "campaign_postal_exports",
        "pledges",
        "donations",
        "merge_history",
        "audit_logs",
        "bank_accounts",
        "campaigns",
        "constituents",
        "users",
      ]) {
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgId}`);
      }
      await tx.execute(sql`DELETE FROM outbox_events WHERE tenant_id = ${orgId}`);
      await tx.execute(sql`DELETE FROM tenants WHERE id = ${orgId}`);
    });
  });

  it("moves pledges, membership, letters and QR / payment references; back-fills the address", async () => {
    const primaryId = await createConstituent({ firstName: "Survivor", lastName: "Repoint" });
    const duplicateId = await createConstituent({
      firstName: "Survivor",
      lastName: "Repoint",
      types: ["volunteer"],
      addressLine1: "12 rue des Lilas",
      postalCode: "69003",
      city: "Lyon",
      countryCode: "FR",
    });

    const [c1, c2] = await db
      .insert(campaigns)
      .values([
        { orgId, name: "Shared campaign", type: "nominative_postal" },
        { orgId, name: "Duplicate-only campaign", type: "nominative_postal" },
      ])
      .returning({ id: campaigns.id });
    // Raw insert with the minimal column set — every other column defaults.
    const e1 = { id: randomUUID() };
    const e2 = { id: randomUUID() };
    await db.execute(sql`
      INSERT INTO campaign_postal_exports (id, org_id, campaign_id, mode)
      VALUES (${e1.id}, ${orgId}, ${c1!.id}, 'personalized'),
             (${e2.id}, ${orgId}, ${c2!.id}, 'personalized')
    `);
    const [account] = await db
      .insert(bankAccounts)
      .values({
        orgId,
        holderName: "Merge Repoint Org",
        holderStreet: "Rue du Test 1",
        holderPostalCode: "1003",
        holderTown: "Lausanne",
        holderCountryCode: "CH",
        iban: "CH9300762011623852957",
        ibanKind: "iban",
        bankName: "Test Bank",
        currency: "CHF",
      })
      .returning({ id: bankAccounts.id });

    await db.insert(campaignConstituents).values([
      { orgId, campaignId: c1!.id, constituentId: primaryId },
      { orgId, campaignId: c1!.id, constituentId: duplicateId },
      { orgId, campaignId: c2!.id, constituentId: duplicateId },
    ]);
    const [pledge] = await db
      .insert(pledges)
      .values({
        orgId,
        constituentId: duplicateId,
        amountCents: 2000,
        amountBaseCents: 2000,
        frequency: "monthly",
      })
      .returning({ id: pledges.id });
    const [letter] = await db
      .insert(campaignDocuments)
      .values({ orgId, campaignId: c2!.id, constituentId: duplicateId, s3Path: "x/letter.pdf" })
      .returning({ id: campaignDocuments.id });

    const qr = (constituentId: string, campaignId: string, exportId: string | null, code: string) =>
      ({ orgId, campaignId, constituentId, exportId, code }) as const;
    await db.insert(campaignQrCodes).values([
      qr(primaryId, c1!.id, e1.id, "qr-survivor-e1"),
      qr(duplicateId, c1!.id, e1.id, "qr-dup-e1"), // same export as the survivor's → stays
      qr(duplicateId, c2!.id, e2.id, "qr-dup-e2"),
      qr(duplicateId, c2!.id, null, "qr-dup-legacy"),
    ]);
    const ref = (constituentId: string, campaignId: string, exportId: string, reference: string) =>
      ({
        orgId,
        campaignId,
        constituentId,
        exportId,
        bankAccountId: account!.id,
        referenceType: "scor",
        reference,
        currency: "CHF",
      }) as const;
    await db.insert(swissQrReferences).values([
      ref(primaryId, c1!.id, e1.id, "RF18000000000000000001"),
      ref(duplicateId, c1!.id, e1.id, "RF18000000000000000002"), // stays
      ref(duplicateId, c2!.id, e2.id, "RF18000000000000000003"),
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(token),
      payload: { targetId: duplicateId },
    });
    expect(res.statusCode).toBe(200);

    // Pledge + letter follow the survivor.
    const [movedPledge] = await db.select().from(pledges).where(eq(pledges.id, pledge!.id));
    expect(movedPledge?.constituentId).toBe(primaryId);
    const [movedLetter] = await db
      .select()
      .from(campaignDocuments)
      .where(eq(campaignDocuments.id, letter!.id));
    expect(movedLetter?.constituentId).toBe(primaryId);

    // Membership: survivor is in BOTH campaigns exactly once, duplicate in none.
    const members = await db
      .select({
        campaignId: campaignConstituents.campaignId,
        constituentId: campaignConstituents.constituentId,
      })
      .from(campaignConstituents)
      .where(eq(campaignConstituents.orgId, orgId));
    expect(members.every((m) => m.constituentId === primaryId)).toBe(true);
    expect(members.map((m) => m.campaignId).sort()).toEqual([c1!.id, c2!.id].sort());

    // QR codes: everything moves except the one colliding with the survivor's
    // own code for the same export (unique `(export_id, constituent_id)`).
    const codes = await db
      .select({ code: campaignQrCodes.code, constituentId: campaignQrCodes.constituentId })
      .from(campaignQrCodes)
      .where(eq(campaignQrCodes.orgId, orgId));
    const owner = Object.fromEntries(codes.map((c) => [c.code, c.constituentId]));
    expect(owner).toEqual({
      "qr-survivor-e1": primaryId,
      "qr-dup-e1": duplicateId,
      "qr-dup-e2": primaryId,
      "qr-dup-legacy": primaryId,
    });

    const refs = await db
      .select({
        reference: swissQrReferences.reference,
        constituentId: swissQrReferences.constituentId,
      })
      .from(swissQrReferences)
      .where(eq(swissQrReferences.orgId, orgId));
    expect(Object.fromEntries(refs.map((r) => [r.reference, r.constituentId]))).toEqual({
      RF18000000000000000001: primaryId,
      RF18000000000000000002: duplicateId,
      RF18000000000000000003: primaryId,
    });

    // Address back-filled as a block; types untouched while the
    // `constituents.multi_type` flag is off for the tenant.
    const survivor = await getRow(primaryId);
    expect(survivor).toMatchObject({
      addressLine1: "12 rue des Lilas",
      postalCode: "69003",
      city: "Lyon",
      countryCode: "FR",
      types: ["donor"],
      type: "donor",
    });
  });

  it("never splices two addresses; unions types when the tenant is multi-type", async () => {
    const primaryId = await createConstituent({
      firstName: "Partial",
      lastName: "Address",
      city: "Paris",
    });
    const duplicateId = await createConstituent({
      firstName: "Partial",
      lastName: "Address",
      types: ["volunteer"],
      addressLine1: "5 quai de Saône",
      postalCode: "69002",
      city: "Lyon",
    });

    const result = await mergeConstituents(
      orgId,
      primaryId,
      duplicateId,
      { userId: sub },
      { unionTypes: true },
    );
    expect(result?.merged).toBe(true);

    const survivor = await getRow(primaryId);
    expect(survivor).toMatchObject({
      addressLine1: null,
      postalCode: null,
      city: "Paris",
      types: ["donor", "volunteer"],
      // Legacy shadow keeps mirroring `types[0]`.
      type: "donor",
    });
  });

  it("opposite concurrent merges (A←B and B←A) do not deadlock — exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await createConstituent({ firstName: "Dead", lastName: `Lock${round}` });
      const b = await createConstituent({ firstName: "Dead", lastName: `Lock${round}` });
      const results = await Promise.all([
        mergeConstituents(orgId, a, b, { userId: sub }),
        mergeConstituents(orgId, b, a, { userId: sub }),
      ]);
      // The loser sees its survivor already soft-deleted → `null` (route 404).
      expect(results.filter((r) => r?.merged)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(1);
    }
  });
});

// ─── Merge RLS Isolation (QA #3 — bidirectional) ────────────────────────────

describe("Constituents merge RLS isolation", () => {
  let tenantAConstituentId: string;
  let tenantAConstituentId2: string;
  let tenantBConstituentId: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "RLS", lastName: "MergeA", type: "donor" },
    });
    tenantAConstituentId = res1.json<{ data: { id: string } }>().data.id;

    const res1b = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "RLS", lastName: "MergeA2", type: "donor" },
    });
    tenantAConstituentId2 = res1b.json<{ data: { id: string } }>().data.id;

    const tokenB = signTokenB(app);
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenB),
      payload: { firstName: "RLS", lastName: "MergeB", type: "donor" },
    });
    tenantBConstituentId = res2.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant A cannot merge Tenant A constituent INTO Tenant B constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${tenantAConstituentId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: tenantBConstituentId },
    });

    // targetId (Tenant B) is invisible to Tenant A — merge fails with 404
    expect(res.statusCode).toBe(404);
  });

  it("Tenant A cannot merge Tenant B constituent INTO Tenant A constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${tenantBConstituentId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: tenantAConstituentId2 },
    });

    // primary (Tenant B) is invisible to Tenant A — merge fails with 404
    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot merge Tenant A constituents", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${tenantAConstituentId}/merge`,
      headers: authHeader(tokenB),
      payload: { targetId: tenantBConstituentId },
    });

    // primary (Tenant A) is invisible to Tenant B — merge fails with 404
    expect(res.statusCode).toBe(404);
  });

  it("audit_logs record merge actions with correct attribution", async () => {
    // Perform a successful merge within Tenant A to verify audit logging
    const tokenA = signToken(app);

    // Create two fresh constituents for a successful merge
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Audit", lastName: "Primary", type: "donor" },
    });
    const auditPrimaryId = res1.json<{ data: { id: string } }>().data.id;

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Audit", lastName: "Duplicate", type: "donor" },
    });
    const auditDuplicateId = res2.json<{ data: { id: string } }>().data.id;

    const mergeRes = await app.inject({
      method: "POST",
      url: `/v1/constituents/${auditPrimaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: auditDuplicateId },
    });
    expect(mergeRes.statusCode).toBe(200);

    // Verify outbox events contain correct actor_user_id attribution
    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A}
            AND type = 'constituent.merged'
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    const payload = (rows.rows[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.survivorId).toBe(auditPrimaryId);
    expect(payload.mergedId).toBe(auditDuplicateId);
    expect(payload.mergedBy).toBe(USER_A);
  });
});
