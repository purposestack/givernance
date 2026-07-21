/**
 * Constituent custom-field values — write/read path + CSV export
 * (Epic #539 PR-2/PR-6 scope, docs/35 §4/§6).
 *
 * Covers, end to end through the real routes:
 *   - flag OFF: `custom` payload → 422 `custom_fields_disabled`, responses
 *     carry no `custom` key, `/export.csv` 404s;
 *   - flag ON: the 422 matrix (unknown_key / invalid_type / unknown_option /
 *     inactive_option / not_integer / required_missing, errors collected);
 *   - merge-patch semantics (absent untouched, explicit null clears);
 *   - the strict-serializer firewall (stray DB keys never leave the API);
 *   - CSV export: exportable columns in admin order, option ids → labels,
 *     multi joined '; ', cents → major unit, Art. 9 header flag, formula
 *     neutralisation, `?filters=` DSL honored + gated;
 *   - merge conflict rule: survivor wins, missing keys copied;
 *   - outbox change-sets record `{ customKeysChanged }`, never values.
 *
 * Runs under BOTH CI roles — the `api-tests-app` (NOBYPASSRLS) job is the
 * tenant-isolation gate (issue #455). Fixture seeding (definitions, flag
 * toggles, stray-blob writes) uses the owner `db` from the helpers.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  constituents,
  customFieldDefinitions,
  featureFlags,
  outboxEvents,
} from "@givernance/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { invalidateDefinitionsCache } from "../../modules/customization/lib/value-service.js";
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
let token: string;
const createdIds: string[] = [];
const BOM = "\uFEFF";

async function setFlag(key: string, enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, key));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
}

type DefSeed = Partial<typeof customFieldDefinitions.$inferInsert> & {
  key: string;
  type: (typeof customFieldDefinitions.$inferInsert)["type"];
};

async function seedDef(seed: DefSeed) {
  const [row] = await db
    .insert(customFieldDefinitions)
    .values({ orgId: ORG_A, domain: "constituent", label: seed.key, ...seed })
    .returning();
  await invalidateDefinitionsCache(ORG_A);
  return row;
}

async function createViaApi(payload: Record<string, unknown>): Promise<{
  status: number;
  body: { data?: { id: string; custom?: Record<string, unknown> }; custom_field_errors?: unknown };
}> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(token),
    payload: { firstName: "CFV", lastName: "Values", ...payload },
  });
  const body = res.json();
  if (res.statusCode === 201 && body.data?.id) createdIds.push(body.data.id);
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  token = signToken(app);

  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, ORG_A));
  await invalidateDefinitionsCache(ORG_A);

  // The catalog every test below runs against — admin sort order is the
  // export column order.
  await seedDef({
    key: "segment",
    label: "Segment donateur",
    type: "picklist",
    sortOrder: 1,
    options: [
      { id: "opt_grand001", label: "Grand donateur", active: true, sortOrder: 0 },
      { id: "opt_ancien01", label: "Ancien", active: false, sortOrder: 1 },
    ],
  });
  await seedDef({ key: "member_note", label: "Note membre", type: "text", sortOrder: 2 });
  await seedDef({ key: "score", label: "Score", type: "number", sortOrder: 3 });
  await seedDef({ key: "board_member", label: "Membre du conseil", type: "boolean", sortOrder: 4 });
  await seedDef({
    key: "interests",
    label: "Centres d'intérêt",
    type: "multi_picklist",
    sortOrder: 5,
    options: [
      { id: "opt_envir001", label: "Environnement", active: true, sortOrder: 0 },
      { id: "opt_educa001", label: "Éducation", active: true, sortOrder: 1 },
    ],
  });
  await seedDef({ key: "pledge_amount", label: "Promesse", type: "currency", sortOrder: 6 });
  await seedDef({
    key: "health_note",
    label: "Note santé",
    type: "text",
    sortOrder: 7,
    sensitive: true,
    purposeText: "Adaptation des visites aux bénéficiaires",
  });
  await seedDef({
    key: "internal_code",
    label: "Code interne",
    type: "text",
    sortOrder: 8,
    exportable: false,
  });
});

afterAll(async () => {
  await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
  await setFlag(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, false);
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, ORG_A));
  await invalidateDefinitionsCache(ORG_A);
  for (const id of createdIds) {
    await db.delete(outboxEvents).where(sql`payload->>'constituentId' = ${id}`);
    await db.delete(constituents).where(eq(constituents.id, id));
  }
  await app.close();
});

describe("flag OFF — custom affordance absent", () => {
  beforeAll(() => setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false));

  it("rejects a create payload carrying custom with 422 custom_fields_disabled", async () => {
    const res = await createViaApi({ custom: { member_note: "hello" } });
    expect(res.status).toBe(422);
    expect((res.body as { title?: string }).title).toBe("custom_fields_disabled");
  });

  it("rejects an update payload carrying custom with 422", async () => {
    const created = await createViaApi({});
    expect(created.status).toBe(201);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${created.body.data?.id}`,
      headers: authHeader(token),
      payload: { custom: { member_note: "hello" } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().title).toBe("custom_fields_disabled");
  });

  it("accepts an empty custom object on create AND update (uniform gate — only actual values are rejected)", async () => {
    const created = await createViaApi({ custom: {} });
    expect(created.status).toBe(201);
    expect(created.body.data).not.toHaveProperty("custom");

    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${created.body.data?.id}`,
      headers: authHeader(token),
      payload: { firstName: "StillWorks", custom: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.firstName).toBe("StillWorks");
    expect(res.json().data).not.toHaveProperty("custom");
  });

  it("omits the custom key from responses even when the DB blob has values", async () => {
    const created = await createViaApi({});
    const id = created.body.data?.id as string;
    await db
      .update(constituents)
      .set({ custom: { member_note: "seeded-off-flag" } })
      .where(and(eq(constituents.id, id), eq(constituents.orgId, ORG_A)));

    const detail = await app.inject({
      method: "GET",
      url: `/v1/constituents/${id}`,
      headers: authHeader(token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).not.toHaveProperty("custom");
    expect(detail.body).not.toContain("seeded-off-flag");
  });

  it("404s the export route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/export.csv",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("flag ON — 422 matrix", () => {
  beforeAll(() => setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true));

  it("rejects an unknown key", async () => {
    const res = await createViaApi({ custom: { nope: "x" } });
    expect(res.status).toBe(422);
    expect(res.body.custom_field_errors).toEqual([
      expect.objectContaining({ key: "nope", code: "unknown_key" }),
    ]);
  });

  it("rejects a deactivated picklist option", async () => {
    const res = await createViaApi({ custom: { segment: "opt_ancien01" } });
    expect(res.status).toBe(422);
    expect(res.body.custom_field_errors).toEqual([
      expect.objectContaining({ key: "segment", code: "inactive_option" }),
    ]);
  });

  it("rejects an unknown picklist option", async () => {
    const res = await createViaApi({ custom: { segment: "opt_nothere1" } });
    expect(res.status).toBe(422);
    expect(res.body.custom_field_errors).toEqual([
      expect.objectContaining({ key: "segment", code: "unknown_option" }),
    ]);
  });

  it("rejects a type mismatch and non-integer cents — errors collected, not first-failure", async () => {
    const res = await createViaApi({ custom: { member_note: 42, pledge_amount: 10.5 } });
    expect(res.status).toBe(422);
    expect(res.body.custom_field_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "member_note", code: "invalid_type" }),
        expect.objectContaining({ key: "pledge_amount", code: "not_integer" }),
      ]),
    );
  });

  it("enforces required definitions on create only", async () => {
    const def = await seedDef({
      key: "required_field",
      label: "Champ requis",
      type: "text",
      required: true,
      sortOrder: 99,
    });
    try {
      // Create WITHOUT the field — even without a `custom` object at all.
      const missing = await createViaApi({});
      expect(missing.status).toBe(422);
      expect(missing.body.custom_field_errors).toEqual([
        expect.objectContaining({ key: "required_field", code: "required_missing" }),
      ]);

      const provided = await createViaApi({ custom: { required_field: "present" } });
      expect(provided.status).toBe(201);

      // Update of another field is NOT retro-blocked by the required def.
      const update = await app.inject({
        method: "PUT",
        url: `/v1/constituents/${provided.body.data?.id}`,
        headers: authHeader(token),
        payload: { custom: { member_note: "unrelated edit" } },
      });
      expect(update.statusCode).toBe(200);
    } finally {
      if (def) {
        await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, def.id));
        await invalidateDefinitionsCache(ORG_A);
      }
    }
  });
});

describe("flag ON — merge-patch semantics + serializer firewall", () => {
  beforeAll(() => setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true));

  it("creates with a full custom blob and serializes it back", async () => {
    const res = await createViaApi({
      custom: {
        segment: "opt_grand001",
        member_note: "  trimmed  ",
        score: 7,
        board_member: true,
        interests: ["opt_envir001", "opt_educa001", "opt_envir001"],
        pledge_amount: 12345,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data?.custom).toEqual({
      segment: "opt_grand001",
      member_note: "trimmed",
      score: 7,
      board_member: true,
      // deduped by the validator
      interests: ["opt_envir001", "opt_educa001"],
      pledge_amount: 12345,
    });
  });

  it("leaves absent keys untouched and clears explicit nulls", async () => {
    const created = await createViaApi({
      custom: { member_note: "keep me", score: 3, board_member: true },
    });
    const id = created.body.data?.id as string;

    const patch = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${id}`,
      headers: authHeader(token),
      payload: { custom: { score: 9, board_member: null } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.custom).toEqual({ member_note: "keep me", score: 9 });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/constituents/${id}`,
      headers: authHeader(token),
    });
    expect(detail.json().data.custom).toEqual({ member_note: "keep me", score: 9 });
  });

  it("never serializes keys without a definition (stray values stay in the DB only; archived defs DO serialize on detail + export — covered below)", async () => {
    const created = await createViaApi({ custom: { member_note: "visible" } });
    const id = created.body.data?.id as string;
    await db
      .update(constituents)
      .set({ custom: { member_note: "visible", stray_key: "stray-value-77" } })
      .where(and(eq(constituents.id, id), eq(constituents.orgId, ORG_A)));

    const detail = await app.inject({
      method: "GET",
      url: `/v1/constituents/${id}`,
      headers: authHeader(token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.custom).toEqual({ member_note: "visible" });
    expect(detail.body).not.toContain("stray-value-77");

    // Value retained in storage — archive/stray semantics keep data.
    const [row] = await db
      .select()
      .from(constituents)
      .where(and(eq(constituents.id, id), eq(constituents.orgId, ORG_A)));
    expect(row?.custom).toMatchObject({ stray_key: "stray-value-77" });
  });

  it("serializes custom on list rows too", async () => {
    const created = await createViaApi({
      firstName: "ListCustom",
      custom: { member_note: "on the list" },
    });
    const list = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=ListCustom",
      headers: authHeader(token),
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().data.find((r: { id: string }) => r.id === created.body.data?.id);
    expect(row?.custom).toEqual({ member_note: "on the list" });
  });

  it("does not leak custom cross-tenant (ADR-019: 404)", async () => {
    const created = await createViaApi({ custom: { member_note: "tenant A only" } });
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${created.body.data?.id}`,
      headers: authHeader(signTokenB(app)),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("flag ON — merge conflict rule", () => {
  beforeAll(() => setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true));

  it("survivor wins, missing keys copied from the duplicate", async () => {
    const survivor = await createViaApi({
      firstName: "MergeSurvivor",
      custom: { member_note: "survivor note", score: 1 },
    });
    const duplicate = await createViaApi({
      firstName: "MergeDuplicate",
      custom: { score: 99, board_member: true },
    });

    const adminToken = signToken(app, { role: "org_admin" });
    const merge = await app.inject({
      method: "POST",
      url: `/v1/constituents/${survivor.body.data?.id}/merge`,
      headers: authHeader(adminToken),
      payload: { targetId: duplicate.body.data?.id },
    });
    expect(merge.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/constituents/${survivor.body.data?.id}`,
      headers: authHeader(token),
    });
    expect(detail.json().data.custom).toEqual({
      member_note: "survivor note",
      score: 1,
      board_member: true,
    });
  });
});

describe("flag ON — outbox change-set sanitisation", () => {
  beforeAll(() => setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true));

  it("records customKeysChanged, never the values", async () => {
    const created = await createViaApi({});
    const id = created.body.data?.id as string;
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${id}`,
      headers: authHeader(token),
      payload: { custom: { member_note: "outbox-secret-42", score: 5 } },
    });
    expect(res.statusCode).toBe(200);

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, ORG_A),
          eq(outboxEvents.type, "constituent.updated"),
          sql`payload->>'constituentId' = ${id}`,
        ),
      )
      .orderBy(desc(outboxEvents.createdAt))
      .limit(1);

    expect(event).toBeDefined();
    const payload = event?.payload as { changes?: { customKeysChanged?: string[] } };
    expect(payload.changes?.customKeysChanged?.sort()).toEqual(["member_note", "score"]);
    expect(JSON.stringify(event)).not.toContain("outbox-secret-42");
  });
});

describe("flag ON — CSV export", () => {
  const exportEmail = `cfv-export-${Date.now()}@example.org`;

  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
    await setFlag(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, true);
    await createViaApi({
      firstName: "ExportRow",
      lastName: "One",
      email: exportEmail,
      types: ["donor"],
      tags: ["export-tag"],
      custom: {
        segment: "opt_grand001",
        member_note: '=HYPERLINK("http://evil","x")',
        interests: ["opt_envir001", "opt_educa001"],
        pledge_amount: 12345,
        internal_code: "not-for-export-55",
      },
    });
  });

  it("emits canonical headers + exportable defs in admin order, Art. 9 flagged", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/export.csv",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("constituents-export-");

    const [headerLine] = res.body.split("\r\n");
    expect(headerLine?.startsWith(BOM)).toBe(true);
    expect(headerLine).toBe(
      BOM +
        [
          "firstName",
          "lastName",
          "email",
          "phone",
          "addressLine1",
          "addressLine2",
          "postalCode",
          "city",
          "countryCode",
          "types",
          "tags",
          "createdAt",
          "Segment donateur",
          "Note membre",
          "Score",
          "Membre du conseil",
          "Centres d'intérêt",
          "Promesse",
          "Note santé (Art. 9)",
        ].join(","),
    );
    // exportable=false definitions never produce a column.
    expect(headerLine).not.toContain("Code interne");
    expect(res.body).not.toContain("not-for-export-55");
  });

  it("resolves option labels, joins multi '; ', formats cents, neutralises formulas", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/export.csv",
      headers: authHeader(token),
    });
    const row = res.body.split("\r\n").find((line: string) => line.includes(exportEmail));
    expect(row).toBeDefined();
    expect(row).toContain("Grand donateur");
    expect(row).toContain("Environnement; Éducation");
    expect(row).toContain("123.45");
    // OWASP CSV-injection neutraliser: leading `=` gets a `'` prefix + quoting.
    expect(row).toContain("\"'=HYPERLINK");
  });

  it("honors the ?filters= DSL", async () => {
    const filters = encodeURIComponent(
      JSON.stringify({
        operator: "AND",
        conditions: [{ field: "constituent.email", operator: "eq", value: exportEmail }],
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/export.csv?filters=${filters}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const dataLines = res.body.split("\r\n").filter((line: string) => line.length > 0);
    // header + exactly the one matching row
    expect(dataLines).toHaveLength(2);
    expect(dataLines[1]).toContain(exportEmail);
  });

  it("404s the filters param when advanced_filters is off, and 400s bad JSON", async () => {
    await setFlag(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, false);
    const gated = await app.inject({
      method: "GET",
      url: `/v1/constituents/export.csv?filters=${encodeURIComponent("{}")}`,
      headers: authHeader(token),
    });
    expect(gated.statusCode).toBe(404);

    await setFlag(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, true);
    const bad = await app.inject({
      method: "GET",
      url: `/v1/constituents/export.csv?filters=${encodeURIComponent("{not json")}`,
      headers: authHeader(token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("401s without auth (flag on — requireFlag first, then requireAuth)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/constituents/export.csv" });
    expect(res.statusCode).toBe(401);
  });
});

describe("flag ON — archived-definition readability (detail + export)", () => {
  const archivedEmail = `cfv-archived-${Date.now()}@example.org`;
  let defId: string;
  let rowId: string;
  const createdDefIds: string[] = [];

  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
    // Definition + value created through the API (org_admin token), so the
    // archive below exercises the real route-side lifecycle.
    const def = await app.inject({
      method: "POST",
      url: "/v1/custom-fields",
      headers: authHeader(token),
      payload: { domain: "constituent", key: "legacy_status", label: "Legacy V1", type: "text" },
    });
    expect(def.statusCode).toBe(201);
    defId = def.json().data.id;
    createdDefIds.push(defId);

    const created = await createViaApi({
      firstName: "ArchivedReadable",
      email: archivedEmail,
      custom: { legacy_status: "retired" },
    });
    expect(created.status).toBe(201);
    rowId = created.body.data?.id as string;
  });

  afterAll(async () => {
    for (const id of createdDefIds) {
      await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));
    }
    await invalidateDefinitionsCache(ORG_A);
  });

  it("keeps the archived definition's value readable on detail, out of list rows, and in the export with an '(archived)' header", async () => {
    const archived = await app.inject({
      method: "DELETE",
      url: `/v1/custom-fields/${defId}`,
      headers: authHeader(token),
    });
    expect(archived.statusCode).toBe(200);

    // Detail serializes active + archived definitions (docs/35 §4).
    const detail = await app.inject({
      method: "GET",
      url: `/v1/constituents/${rowId}`,
      headers: authHeader(token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.custom).toMatchObject({ legacy_status: "retired" });

    // List rows stay active-only.
    const list = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=ArchivedReadable",
      headers: authHeader(token),
    });
    const row = list.json().data.find((r: { id: string }) => r.id === rowId);
    expect(row?.custom).not.toHaveProperty("legacy_status");

    // Export keeps the column, suffixed '(archived)', value included.
    const csv = await app.inject({
      method: "GET",
      url: "/v1/constituents/export.csv",
      headers: authHeader(token),
    });
    expect(csv.statusCode).toBe(200);
    const [headerLine] = csv.body.split("\r\n");
    expect(headerLine).toContain("Legacy V1 (archived)");
    const dataRow = csv.body.split("\r\n").find((line: string) => line.includes(archivedEmail));
    expect(dataRow).toContain("retired");
  });

  it("archived-then-recreated same key: the active definition wins — the value serializes once, no duplicate export column", async () => {
    // Recreate the archived key as a new active definition (the documented
    // type-change path — archive + recreate).
    const recreated = await app.inject({
      method: "POST",
      url: "/v1/custom-fields",
      headers: authHeader(token),
      payload: { domain: "constituent", key: "legacy_status", label: "Legacy V2", type: "number" },
    });
    expect(recreated.statusCode).toBe(201);
    createdDefIds.push(recreated.json().data.id);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/constituents/${rowId}`,
      headers: authHeader(token),
    });
    expect(detail.statusCode).toBe(200);
    // The blob holds one value per key; the active twin owns it.
    expect(detail.json().data.custom.legacy_status).toBe("retired");

    const csv = await app.inject({
      method: "GET",
      url: "/v1/constituents/export.csv",
      headers: authHeader(token),
    });
    const [headerLine] = csv.body.split("\r\n");
    // Exactly ONE column for the key: the active V2 — the archived V1 twin
    // is deduped out of the readable catalog.
    expect(headerLine).toContain("Legacy V2");
    expect(headerLine).not.toContain("Legacy V1");
    expect(headerLine?.match(/Legacy/g)).toHaveLength(1);
  });
});

describe("flag ON — definition mutations invalidate the value-path catalog cache", () => {
  const cacheEmail = `cfv-cache-${Date.now()}@example.org`;
  let defId: string;
  let rowId: string;

  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
  });

  afterAll(async () => {
    if (defId) {
      await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, defId));
    }
    await invalidateDefinitionsCache(ORG_A);
  });

  it("a definition created through the API is usable on the value path within the same second (no 60 s staleness)", async () => {
    // Warm the (org × constituent) catalog cache through a real value read
    // BEFORE the definition exists — a dropped invalidateDefinitionsCache
    // call in the create path would leave this stale set cached for 60 s.
    const warm = await app.inject({
      method: "GET",
      url: "/v1/constituents?page=1&limit=1",
      headers: authHeader(token),
    });
    expect(warm.statusCode).toBe(200);

    const def = await app.inject({
      method: "POST",
      url: "/v1/custom-fields",
      headers: authHeader(token),
      payload: { domain: "constituent", key: "cache_probe", label: "Cache probe", type: "text" },
    });
    expect(def.statusCode).toBe(201);
    defId = def.json().data.id;

    // Immediately write a value on the new key: validation reads the active
    // catalog — a stale cache answers 422 unknown_key and fails this test.
    const created = await createViaApi({
      firstName: "CacheProbe",
      email: cacheEmail,
      custom: { cache_probe: "fresh" },
    });
    expect(created.status).toBe(201);
    rowId = created.body.data?.id as string;
    expect(created.body.data?.custom).toMatchObject({ cache_probe: "fresh" });
  });

  it("an archive through the API drops the key from list serialization immediately; a restore re-admits writes immediately", async () => {
    // List read re-warms the cache with the def ACTIVE.
    const before = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=CacheProbe",
      headers: authHeader(token),
    });
    expect(before.json().data.find((r: { id: string }) => r.id === rowId)?.custom).toMatchObject({
      cache_probe: "fresh",
    });

    const archived = await app.inject({
      method: "DELETE",
      url: `/v1/custom-fields/${defId}`,
      headers: authHeader(token),
    });
    expect(archived.statusCode).toBe(200);

    // Immediately: list rows serialize active-only — a stale cached catalog
    // would still carry the def and leave the key on the wire.
    const after = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=CacheProbe",
      headers: authHeader(token),
    });
    const row = after.json().data.find((r: { id: string }) => r.id === rowId);
    expect(row).toBeDefined();
    expect(row?.custom).not.toHaveProperty("cache_probe");

    const restored = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${defId}/restore`,
      headers: authHeader(token),
    });
    expect(restored.statusCode).toBe(200);

    // Immediately: the write path validates against the restored catalog —
    // a stale post-archive cache answers 422 unknown_key.
    const write = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${rowId}`,
      headers: authHeader(token),
      payload: { custom: { cache_probe: "restored" } },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().data.custom).toMatchObject({ cache_probe: "restored" });
  });
});
