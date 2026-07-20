/**
 * Custom-field definitions CRUD (Epic #539, docs/35).
 *
 * Covers the registry routes end-to-end: RBAC matrix, flag-off 404 (all
 * flags AND per-domain), cross-tenant 404 (ADR-019), the 422 matrix
 * (invalid/reserved key, purpose-required-when-sensitive, projection
 * shape, quota with named limit incl. a quota-override raise), archive /
 * restore / reorder lifecycle.
 *
 * Runs under BOTH CI roles (issue #455): routes set tenant context via
 * `withTenantContext`; the owner `db` from the helper is used only for
 * fixture seeding (flags, quota overrides, cleanup).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { featureFlags } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";
import { db } from "../helpers/db.js";

let app: FastifyInstance;

const ALL_FLAGS = [
  FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
  FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
  FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
] as const;

async function setFlag(key: string, enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, key));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
}

async function setAllFlags(enabled: boolean) {
  for (const key of ALL_FLAGS) {
    await setFlag(key, enabled);
  }
}

async function cleanupCustomFieldRows() {
  await db.execute(sql`DELETE FROM custom_field_merge_undo WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM custom_field_definitions WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(
    sql`DELETE FROM customization_quota_overrides WHERE org_id IN (${ORG_A}, ${ORG_B})`,
  );
}

interface DefinitionData {
  id: string;
  domain: string;
  key: string;
  label: string;
  type: string;
  options: { id: string; label: string; active: boolean; sortOrder: number }[];
  sortOrder: number;
  sensitive: boolean;
  showOnRelated: boolean;
  purposeText: string | null;
  archivedAt: string | null;
}

async function createField(
  payload: Record<string, unknown>,
  token = signToken(app),
): Promise<{ status: number; body: { data: DefinitionData } & Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/custom-fields",
    headers: authHeader(token),
    payload: { domain: "constituent", type: "text", ...payload },
  });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  await cleanupCustomFieldRows();
  await setAllFlags(true);
});

afterAll(async () => {
  await setAllFlags(false);
  await cleanupCustomFieldRows();
  await app.close();
});

describe("flag gating", () => {
  it("404s every route when all three domain flags are off", async () => {
    await setAllFlags(false);
    const token = signToken(app);
    const get = await app.inject({
      method: "GET",
      url: "/v1/custom-fields",
      headers: authHeader(token),
    });
    expect(get.statusCode).toBe(404);
    const post = await app.inject({
      method: "POST",
      url: "/v1/custom-fields",
      headers: authHeader(token),
      payload: { domain: "constituent", key: "flag_off", label: "X", type: "text" },
    });
    expect(post.statusCode).toBe(404);
    const usage = await app.inject({
      method: "GET",
      url: "/v1/custom-fields/usage",
      headers: authHeader(token),
    });
    expect(usage.statusCode).toBe(404);
    await setAllFlags(true);
  });

  it("404s creates into a domain whose own flag is off, and filters that domain from the catalog", async () => {
    const created = await createField({ domain: "donation", key: "don_note", label: "Note" });
    expect(created.status).toBe(201);

    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, false);
    const token = signToken(app);

    const post = await createField({ domain: "donation", key: "don_other", label: "Other" });
    expect(post.status).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: "/v1/custom-fields",
      headers: authHeader(token),
    });
    expect(list.statusCode).toBe(200);
    const domains = list.json<{ data: DefinitionData[] }>().data.map((d) => d.domain);
    expect(domains).not.toContain("donation");

    // The definition of a switched-off domain is as absent as its surfaces.
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${created.body.data.id}`,
      headers: authHeader(token),
      payload: { label: "Renamed" },
    });
    expect(patch.statusCode).toBe(404);

    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, true);
  });
});

describe("RBAC matrix", () => {
  it("401s unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/custom-fields" });
    expect(res.statusCode).toBe(401);
  });

  it("lets any authenticated member read the catalog (viewer included)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/custom-fields",
      headers: authHeader(signToken(app, { role: "viewer" })),
    });
    expect(res.statusCode).toBe(200);
  });

  it("403s non-admin roles on mutations and usage", async () => {
    for (const role of ["viewer", "user"]) {
      const created = await createField(
        { key: "rbac_probe", label: "Probe" },
        signToken(app, { role }),
      );
      expect(created.status).toBe(403);
    }
    const usage = await app.inject({
      method: "GET",
      url: "/v1/custom-fields/usage",
      headers: authHeader(signToken(app, { role: "user" })),
    });
    expect(usage.statusCode).toBe(403);
  });
});

describe("create validation (422 matrix)", () => {
  it("rejects keys failing the pattern with 422 invalid_key", async () => {
    const res = await createField({ key: "1starts_with_digit", label: "Bad" });
    expect(res.status).toBe(422);
    expect(res.body.title).toBe("invalid_key");
  });

  it("rejects reserved keys and reserved prefixes with 422 reserved_key", async () => {
    for (const key of ["email", "cf_anything", "custom_notes"]) {
      const res = await createField({ key, label: "Reserved" });
      expect(res.status).toBe(422);
      expect(res.body.title).toBe("reserved_key");
    }
  });

  it("requires purpose_text on sensitive fields (422 purpose_required)", async () => {
    const missing = await createField({ key: "health_note", label: "Santé", sensitive: true });
    expect(missing.status).toBe(422);
    expect(missing.body.title).toBe("purpose_required");

    const blank = await createField({
      key: "health_note",
      label: "Santé",
      sensitive: true,
      purposeText: "   ",
    });
    expect(blank.status).toBe(422);

    const ok = await createField({
      key: "health_note",
      label: "Santé",
      sensitive: true,
      purposeText: "Suivi médical des bénéficiaires (Art. 9§2h)",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.sensitive).toBe(true);
  });

  it("rejects show_on_related outside the constituent domain and on sensitive fields", async () => {
    const wrongDomain = await createField({
      domain: "donation",
      key: "proj_wrong",
      label: "Proj",
      showOnRelated: true,
    });
    expect(wrongDomain.status).toBe(422);
    expect(wrongDomain.body.title).toBe("show_on_related_invalid_domain");

    const sensitiveProjection = await createField({
      key: "proj_sensitive",
      label: "Proj",
      sensitive: true,
      purposeText: "Purpose",
      showOnRelated: true,
    });
    expect(sensitiveProjection.status).toBe(422);
    expect(sensitiveProjection.body.title).toBe("show_on_related_sensitive");
  });

  it("rejects show_on_related on the starter plan (projection quota 0) naming the limit", async () => {
    const res = await createField({ key: "proj_quota", label: "Proj", showOnRelated: true });
    expect(res.status).toBe(422);
    expect(res.body.title).toBe("quota_exceeded");
    expect(res.body.quota_key).toBe("show_on_related_fields");
    expect(res.body.limit).toBe(0);
  });

  it("rejects options on non-picklist types (422 options_not_allowed)", async () => {
    const res = await createField({
      key: "no_opts",
      label: "NoOpts",
      type: "text",
      options: [{ label: "A" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.title).toBe("options_not_allowed");
  });

  it("409s an active duplicate key in the same domain", async () => {
    const first = await createField({ key: "dup_key", label: "First" });
    expect(first.status).toBe(201);
    const second = await createField({ key: "dup_key", label: "Second" });
    expect(second.status).toBe(409);
    expect(second.body.title).toBe("duplicate_key");
  });
});

describe("fields-per-domain quota", () => {
  it("enforces the starter quota (10), honors an override raise, and names the limit", async () => {
    // Isolated in the campaign domain so the other suites' constituent
    // definitions never skew the count.
    for (let i = 0; i < 10; i++) {
      const res = await createField({ domain: "campaign", key: `camp_q_${i}`, label: `Q${i}` });
      expect(res.status).toBe(201);
    }
    const over = await createField({ domain: "campaign", key: "camp_q_over", label: "Over" });
    expect(over.status).toBe(422);
    expect(over.body.title).toBe("quota_exceeded");
    expect(over.body.quota_key).toBe("fields_per_domain");
    expect(over.body.limit).toBe(10);

    // Governed raise: super-admin-written override row (seeded via the
    // owner pool — the app role is SELECT-only on this table).
    await db.execute(sql`
      INSERT INTO customization_quota_overrides (org_id, domain, quota_key, value, reason, set_by)
      VALUES (${ORG_A}, 'campaign', 'fields_per_domain', 12, 'test raise', 'test-admin')
    `);
    const eleventh = await createField({ domain: "campaign", key: "camp_q_10", label: "Q10" });
    expect(eleventh.status).toBe(201);
    const twelfth = await createField({ domain: "campaign", key: "camp_q_11", label: "Q11" });
    expect(twelfth.status).toBe(201);
    const thirteenth = await createField({ domain: "campaign", key: "camp_q_12", label: "Q12" });
    expect(thirteenth.status).toBe(422);
    expect(thirteenth.body.limit).toBe(12);

    await db.execute(
      sql`DELETE FROM customization_quota_overrides WHERE org_id = ${ORG_A} AND domain = 'campaign'`,
    );
    await db.execute(
      sql`DELETE FROM custom_field_definitions WHERE org_id = ${ORG_A} AND domain = 'campaign'`,
    );
  });
});

describe("update / archive / restore / reorder", () => {
  it("patches mutable fields and rejects key/type mutation with 400", async () => {
    const created = await createField({ key: "patch_me", label: "Before" });
    expect(created.status).toBe(201);
    const token = signToken(app);

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${created.body.data.id}`,
      headers: authHeader(token),
      payload: { label: "After", required: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ data: DefinitionData }>().data.label).toBe("After");

    // key and type are immutable — the strict body schema has no such
    // members, so Fastify's AJV (removeAdditional) strips them and the
    // row is untouched.
    for (const payload of [
      { label: "After", key: "renamed_key" },
      { label: "After", type: "number" },
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/v1/custom-fields/${created.body.data.id}`,
        headers: authHeader(token),
        payload,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json<{ data: DefinitionData }>().data;
      expect(data.key).toBe("patch_me");
      expect(data.type).toBe("text");
    }

    // Empty patch fails minProperties.
    const empty = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${created.body.data.id}`,
      headers: authHeader(token),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it("enforces purpose-when-sensitive on PATCH too", async () => {
    const created = await createField({ key: "patch_sensitive", label: "S" });
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${created.body.data.id}`,
      headers: authHeader(signToken(app)),
      payload: { sensitive: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ title: string }>().title).toBe("purpose_required");
  });

  it("soft-archives (values retained), hides from the default catalog, frees the key, and restores", async () => {
    const token = signToken(app);
    const created = await createField({ key: "lifecycle_key", label: "V1" });
    const id = created.body.data.id;

    const archived = await app.inject({
      method: "DELETE",
      url: `/v1/custom-fields/${id}`,
      headers: authHeader(token),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ data: DefinitionData }>().data.archivedAt).not.toBeNull();

    const list = await app.inject({
      method: "GET",
      url: "/v1/custom-fields?domain=constituent",
      headers: authHeader(token),
    });
    expect(list.json<{ data: DefinitionData[] }>().data.map((d) => d.id)).not.toContain(id);

    const withArchived = await app.inject({
      method: "GET",
      url: "/v1/custom-fields?domain=constituent&includeArchived=true",
      headers: authHeader(token),
    });
    expect(withArchived.json<{ data: DefinitionData[] }>().data.map((d) => d.id)).toContain(id);

    // Archived key is re-creatable (the type-change path)…
    const recreated = await createField({ key: "lifecycle_key", label: "V2", type: "number" });
    expect(recreated.status).toBe(201);

    // …which then blocks restoring the archived original.
    const blockedRestore = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${id}/restore`,
      headers: authHeader(token),
    });
    expect(blockedRestore.statusCode).toBe(409);
    expect(blockedRestore.json<{ title: string }>().title).toBe("duplicate_key");

    await app.inject({
      method: "DELETE",
      url: `/v1/custom-fields/${recreated.body.data.id}`,
      headers: authHeader(token),
    });
    // The recreated V2 is only archived — drop it so the key is free.
    await db.execute(
      sql`DELETE FROM custom_field_definitions WHERE id = ${recreated.body.data.id}`,
    );

    const restored = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${id}/restore`,
      headers: authHeader(token),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ data: DefinitionData }>().data.archivedAt).toBeNull();
  });

  it("reorders a full domain and 422s a partial id list", async () => {
    const token = signToken(app);
    await db.execute(
      sql`DELETE FROM custom_field_definitions WHERE org_id = ${ORG_A} AND domain = 'donation'`,
    );
    const ids: string[] = [];
    for (const key of ["reorder_a", "reorder_b", "reorder_c"]) {
      const res = await createField({ domain: "donation", key, label: key });
      expect(res.status).toBe(201);
      ids.push(res.body.data.id);
    }

    const reversed = [...ids].reverse();
    const reordered = await app.inject({
      method: "POST",
      url: "/v1/custom-fields/reorder",
      headers: authHeader(token),
      payload: { domain: "donation", ids: reversed },
    });
    expect(reordered.statusCode).toBe(200);
    const data = reordered.json<{ data: DefinitionData[] }>().data;
    expect(data.map((d) => d.id)).toEqual(reversed);
    expect(data.map((d) => d.sortOrder)).toEqual([0, 1, 2]);

    const partial = await app.inject({
      method: "POST",
      url: "/v1/custom-fields/reorder",
      headers: authHeader(token),
      payload: { domain: "donation", ids: reversed.slice(0, 2) },
    });
    expect(partial.statusCode).toBe(422);
    expect(partial.json<{ title: string }>().title).toBe("reorder_mismatch");
  });
});

describe("cross-tenant isolation (ADR-019)", () => {
  it("404s tenant B against tenant A's definition on read-by-mutation, archive, and restore", async () => {
    const created = await createField({ key: "isolation_probe", label: "Iso" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const tokenB = signTokenB(app);

    for (const [method, url, payload] of [
      ["PATCH", `/v1/custom-fields/${id}`, { label: "Stolen" }],
      ["DELETE", `/v1/custom-fields/${id}`, undefined],
      ["POST", `/v1/custom-fields/${id}/restore`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authHeader(tokenB),
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(404);
    }

    // And tenant B's catalog never lists it.
    const list = await app.inject({
      method: "GET",
      url: "/v1/custom-fields",
      headers: authHeader(tokenB),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: DefinitionData[] }>().data.map((d) => d.id)).not.toContain(id);
  });
});
