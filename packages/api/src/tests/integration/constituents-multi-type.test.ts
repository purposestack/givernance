/**
 * Multi-valued constituent type (issue #465).
 *
 * Exercises the `constituents.multi_type` gate end-to-end: with the flag OFF a
 * constituent stays single-typed (the legacy picklist behaviour, enforced as a
 * 422), with it ON a constituent holds several types. Also covers the `types`
 * array overlap filter and the legacy single-`type` filter folding into it.
 *
 * Runs under BOTH CI roles — the `api-tests-app` (NOBYPASSRLS) job is the
 * tenant-isolation gate. The route sets tenant context via `withTenantContext`;
 * this test only reads response bodies, so it never needs the owner pool except
 * for fixture flag-toggling (owner `db` from the helper, per issue #455).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { constituents, featureFlags } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";
import { db } from "../helpers/db.js";

let app: FastifyInstance;
const createdIds: string[] = [];

async function setMultiTypeFlag(enabled: boolean) {
  await db
    .update(featureFlags)
    .set({ enabled })
    .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
}

interface ConstituentBody {
  data: { id: string; type: string; types: string[] };
}

async function createConstituent(
  payload: Record<string, unknown>,
): Promise<{ status: number; json: () => ConstituentBody }> {
  const token = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(token),
    payload: { firstName: "Multi", lastName: "Type", ...payload },
  });
  if (res.statusCode === 201) createdIds.push(res.json<ConstituentBody>().data.id);
  return { status: res.statusCode, json: () => res.json<ConstituentBody>() };
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await setMultiTypeFlag(false);
  for (const id of createdIds) {
    await db.delete(constituents).where(eq(constituents.id, id));
  }
  await app.close();
});

describe("Constituent multi-type — flag OFF", () => {
  beforeAll(() => setMultiTypeFlag(false));

  it("rejects more than one type with a 422 RFC 9457 multi_type_disabled body", async () => {
    const res = await createConstituent({ types: ["donor", "volunteer"] });
    expect(res.status).toBe(422);
    // Lock the problem+json shape — a regression to a plain string or `{error}`
    // body must fail here, not slip through a status-only assertion (issue #465).
    const body = res.json() as unknown as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(body.status).toBe(422);
    expect(body.title).toBe("multi_type_disabled");
    expect(body.type).toBe("https://httpproblems.com/http-status/422");
    expect(typeof body.detail).toBe("string");
    expect(body.detail.length).toBeGreaterThan(0);
  });

  it("accepts a single type and mirrors it into the legacy `type` column", async () => {
    const res = await createConstituent({ types: ["member"] });
    expect(res.status).toBe(201);
    expect(res.json().data.types).toEqual(["member"]);
    expect(res.json().data.type).toBe("member");
  });

  it("accepts the legacy singular `type` and lifts it into `types`", async () => {
    const res = await createConstituent({ type: "volunteer" });
    expect(res.status).toBe(201);
    expect(res.json().data.types).toEqual(["volunteer"]);
    expect(res.json().data.type).toBe("volunteer");
  });

  it("defaults to ['donor'] when no type is supplied", async () => {
    const res = await createConstituent({});
    expect(res.status).toBe(201);
    expect(res.json().data.types).toEqual(["donor"]);
    expect(res.json().data.type).toBe("donor");
  });
});

describe("Constituent multi-type — flag ON", () => {
  beforeAll(() => setMultiTypeFlag(true));
  afterEach(() => flagService.invalidateTenant(ORG_A));

  it("stores several types and keeps `type` = types[0]", async () => {
    const res = await createConstituent({ types: ["donor", "volunteer", "member"] });
    expect(res.status).toBe(201);
    expect(res.json().data.types).toEqual(["donor", "volunteer", "member"]);
    expect(res.json().data.type).toBe("donor");
  });

  it("PUT replaces the type set", async () => {
    const created = await createConstituent({ types: ["donor"] });
    const id = created.json().data.id;
    const token = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${id}`,
      headers: authHeader(token),
      payload: { types: ["volunteer", "partner"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ConstituentBody>();
    expect(body.data.types).toEqual(["volunteer", "partner"]);
    expect(body.data.type).toBe("volunteer");
  });

  it("filters by ?types= via array overlap (any-of)", async () => {
    const tag = `beneficiary`;
    await createConstituent({ lastName: "Overlap", types: ["beneficiary", "member"] });
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents?types=${tag}&perPage=100`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ data: Array<{ types: string[] }> }>().data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.types.includes("beneficiary"))).toBe(true);
  });

  it("legacy ?type= filter still matches multi-type constituents", async () => {
    await createConstituent({ lastName: "Legacy", types: ["partner", "donor"] });
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents?type=partner&perPage=100`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ data: Array<{ types: string[] }> }>().data;
    expect(rows.some((r) => r.types.includes("partner"))).toBe(true);
  });
});

/**
 * Persisted advanced-filter segments survive the scalar→array migration
 * (issue #465). A segment saved before the migration stores
 * `{field:"constituent.type", operator:"eq"|"in"|"neq", value}`. After the
 * column became `text[]`, those operators are translated (eq→array-contains,
 * in→array-overlap, neq→NOT array-contains). These tests prove the translation
 * both *compiles* (no `text = text[]` 500) and is *semantically correct*, using
 * count-increments so the assertion is robust to any rows other suites left in
 * ORG_A (file-level parallelism is off, so a before/after delta is race-free).
 */
describe("Constituent multi-type — persisted advanced-filter segments survive", () => {
  async function setAdvancedFiltersFlag(enabled: boolean) {
    await db
      .update(featureFlags)
      .set({ enabled })
      .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));
    await flagService.invalidate();
    await flagService.invalidateTenant(ORG_A);
  }

  async function previewTypeSegment(operator: string, value: unknown): Promise<number> {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/filter/preview",
      headers: authHeader(token),
      payload: {
        query: { operator: "AND", conditions: [{ field: "constituent.type", operator, value }] },
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: { count: number } }>().data.count;
  }

  beforeAll(async () => {
    await setMultiTypeFlag(true);
    await setAdvancedFiltersFlag(true);
  });

  afterAll(() => setAdvancedFiltersFlag(false));

  beforeEach(async () => {
    // Preview is rate-limited (20/min/IP); clear the window between cases so a
    // full file run never trips 429. Key separator is a dash, not a colon.
    const rlKeys = await redis.keys("fastify-rate-limit-*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);
    await flagService.invalidateTenant(ORG_A);
  });

  it("legacy `eq` segment → array-contains (counts a newly matching row)", async () => {
    const before = await previewTypeSegment("eq", "beneficiary");
    await createConstituent({ lastName: "SegEq", types: ["beneficiary"] });
    const after = await previewTypeSegment("eq", "beneficiary");
    expect(after).toBe(before + 1);
  });

  it("legacy `in` segment → array-overlap (any-of)", async () => {
    const before = await previewTypeSegment("in", ["partner", "member"]);
    await createConstituent({ lastName: "SegIn", types: ["partner"] });
    const after = await previewTypeSegment("in", ["partner", "member"]);
    expect(after).toBe(before + 1);
  });

  it("legacy `neq` segment → NOT array-contains (excludes holders, includes non-holders)", async () => {
    const beforeNeqDonor = await previewTypeSegment("neq", "donor");
    const beforeNeqVolunteer = await previewTypeSegment("neq", "volunteer");
    await createConstituent({ lastName: "SegNeq", types: ["volunteer"] });
    const afterNeqDonor = await previewTypeSegment("neq", "donor");
    const afterNeqVolunteer = await previewTypeSegment("neq", "volunteer");
    // The volunteer-only row holds no `donor` → counted by `neq donor`.
    expect(afterNeqDonor).toBe(beforeNeqDonor + 1);
    // It DOES hold `volunteer` → excluded by `neq volunteer`.
    expect(afterNeqVolunteer).toBe(beforeNeqVolunteer);
  });
});
