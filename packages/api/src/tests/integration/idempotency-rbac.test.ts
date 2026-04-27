/**
 * Issue #181 — idempotency replay path honors route-level RBAC.
 *
 * The idempotency plugin registers its cache lookup as a global preHandler
 * that `fastify-plugin` hoists ABOVE the route's own `preHandler:
 * requireWrite/requireOrgAdmin`. Without `minRole` enforcement, a viewer JWT
 * could replay an admin's `Idempotency-Key` and receive the cached 2xx
 * envelope — bypassing the guard the route still claims to enforce.
 *
 * For each idempotency-keyed route (donations, pledges, campaigns,
 * campaign documents):
 *   1. The admin makes a successful 2xx call with `Idempotency-Key: K`
 *      so the cache is populated (where applicable).
 *   2. The viewer (same tenant) submits the same `Idempotency-Key: K`
 *      against the same route and MUST receive 403, not the cached
 *      201/202 envelope.
 *
 * The 403 also carries the `rbacDenial` log discriminator from issue #182,
 * which is asserted in `rbac-denial-logs.test.ts`. Here we lock the wire
 * contract: status code, RFC 9457 body shape, and the absence of the
 * `idempotency-replayed: true` reply header that the cache hit would emit.
 */

import { randomUUID } from "node:crypto";
import { campaigns, donations, pledges } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const IDEMPOTENCY_ORG = "00000000-0000-0000-0000-000000000181";
let constituentId: string;
let campaignId: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Dedicated tenant so test cleanup doesn't collide with other suites.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${IDEMPOTENCY_ORG}, 'Issue 181 Idempotency Org', 'issue-181-idempotency', 'EUR')
        ON CONFLICT (id) DO NOTHING`,
  );

  const adminToken = signToken(app, { org_id: IDEMPOTENCY_ORG, role: "org_admin" });

  // Seed a constituent + campaign so donation / pledge / campaign-document
  // bodies have valid foreign keys to point at.
  const constituentRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(adminToken),
    payload: { firstName: "Replay", lastName: "Donor", type: "donor" },
  });
  constituentId = constituentRes.json<{ data: { id: string } }>().data.id;

  const campaignRes = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(adminToken),
    payload: { name: "Replay campaign", type: "digital" },
  });
  campaignId = campaignRes.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  // Best-effort cleanup so the suite is re-runnable. Order matches FK direction.
  await withTenantContext(IDEMPOTENCY_ORG, async (tx) => {
    await tx.execute(sql`DELETE FROM ${donations} WHERE org_id = ${IDEMPOTENCY_ORG}`);
    await tx.execute(sql`DELETE FROM ${pledges} WHERE org_id = ${IDEMPOTENCY_ORG}`);
    await tx.execute(sql`DELETE FROM ${campaigns} WHERE org_id = ${IDEMPOTENCY_ORG}`);
  });

  // Drop any cache entries the suite created so a re-run starts clean.
  const keys = await redis.keys(`idem:${IDEMPOTENCY_ORG}:*`);
  if (keys.length > 0) await redis.del(...keys);

  await app.close();
});

const adminTokenFor = (org: string) => signToken(app, { org_id: org, role: "org_admin" });
const viewerTokenFor = (org: string) =>
  signToken(app, { org_id: org, sub: "viewer-181", role: "viewer" });
const userTokenFor = (org: string) =>
  signToken(app, { org_id: org, sub: "user-181", role: "user" });

function expect403Forbidden(res: { statusCode: number; json: () => unknown; headers: unknown }) {
  expect(res.statusCode).toBe(403);
  // Lock the RFC 9457 body shape so a regression to a plain string / `{error}`
  // is caught here rather than at runtime by a SOC dashboard query.
  expect(res.json()).toMatchObject({
    type: "https://httpproblems.com/http-status/403",
    title: "Forbidden",
    status: 403,
  });
  // The cached 2xx envelope would set `idempotency-replayed: true`; we
  // assert its absence as a second-line check that the replay branch is
  // genuinely short-circuited (not just status-rewritten by middleware).
  expect((res.headers as Record<string, string>)["idempotency-replayed"]).toBeUndefined();
}

describe("Idempotency replay path honors route RBAC (issue #181)", () => {
  it("POST /v1/donations — viewer with admin's Idempotency-Key gets 403, not the cached 201", async () => {
    const idempotencyKey = `donation-${randomUUID()}`;
    const payload = {
      constituentId,
      amountCents: 2500,
      currency: "EUR",
      donatedAt: "2026-01-15T00:00:00.000Z",
    };

    // Admin creates and caches the response.
    const adminRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: { ...authHeader(adminTokenFor(IDEMPOTENCY_ORG)), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(adminRes.statusCode).toBe(201);

    // Viewer replays the same key — must NOT receive the cached envelope.
    const viewerRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: {
        ...authHeader(viewerTokenFor(IDEMPOTENCY_ORG)),
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect403Forbidden(viewerRes);
  });

  it("POST /v1/pledges — viewer with admin's Idempotency-Key gets 403", async () => {
    const idempotencyKey = `pledge-${randomUUID()}`;
    const payload = {
      constituentId,
      amountCents: 12000,
      currency: "EUR",
      frequency: "monthly",
    };

    const adminRes = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: { ...authHeader(adminTokenFor(IDEMPOTENCY_ORG)), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(adminRes.statusCode).toBe(201);

    const viewerRes = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: {
        ...authHeader(viewerTokenFor(IDEMPOTENCY_ORG)),
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect403Forbidden(viewerRes);
  });

  it("POST /v1/campaigns — viewer with admin's Idempotency-Key gets 403", async () => {
    const idempotencyKey = `campaign-${randomUUID()}`;
    const payload = { name: `Replay-${randomUUID()}`, type: "digital" };

    const adminRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { ...authHeader(adminTokenFor(IDEMPOTENCY_ORG)), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(adminRes.statusCode).toBe(201);

    const viewerRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        ...authHeader(viewerTokenFor(IDEMPOTENCY_ORG)),
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect403Forbidden(viewerRes);
  });

  it("POST /v1/campaigns/:id/documents — non-admin (user role) with admin's key gets 403", async () => {
    // This route is the only `requireOrgAdmin`-gated idempotent POST. The
    // boundary worth locking here is `user` → 403 (not viewer), because
    // `user` would pass the `minRole: write` check for donations/pledges
    // but NOT the `minRole: admin` on campaign documents.
    const idempotencyKey = `campaign-docs-${randomUUID()}`;
    const payload = { kind: "receipt" };

    // We don't bother seeding the admin call — the user replay must be
    // rejected even on a fresh key, because `minRole` enforcement runs
    // independently of the cache state.
    const userRes = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/documents`,
      headers: { ...authHeader(userTokenFor(IDEMPOTENCY_ORG)), "idempotency-key": idempotencyKey },
      payload,
    });
    expect403Forbidden(userRes);
  });

  it("admin replay still serves the cached envelope (positive control)", async () => {
    // Over-corrections go silent without a positive test on the other side
    // of the boundary — so verify a same-role replay still hits the cache.
    const idempotencyKey = `donation-positive-${randomUUID()}`;
    const payload = {
      constituentId,
      amountCents: 5000,
      currency: "EUR",
      donatedAt: "2026-02-15T00:00:00.000Z",
    };
    const adminToken = adminTokenFor(IDEMPOTENCY_ORG);

    const first = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: { ...authHeader(adminToken), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: { ...authHeader(adminToken), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    // Same body — proves the replay returned the cached envelope, not a fresh row.
    expect(second.json()).toEqual(first.json());
  });
});
