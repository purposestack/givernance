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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
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

  it("rejects more than one type with 422 multi_type_disabled", async () => {
    const res = await createConstituent({ types: ["donor", "volunteer"] });
    expect(res.status).toBe(422);
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
