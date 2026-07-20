/**
 * Integration tests for custom-field filtering (Epic #539 — the two-layer
 * registry, JSONB resolver lanes, archived-field 400, catalog enrichment,
 * custom sort and suggestions). Runs under BOTH CI roles; the api-tests-app
 * (NOBYPASSRLS) job is the tenant-isolation gate — route code resolves the
 * registry and executes queries through withTenantContext.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  constituents,
  customFieldDefinitions,
  donations,
  featureFlags,
} from "@givernance/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";
import { db, withTenantContext } from "../helpers/db.js";

interface CatalogField {
  name: string;
  type: string;
  operators: string[];
  label: string;
  labelKind: "literal" | "i18n";
  category: string;
  nullable: boolean;
  uiType?: string;
  options?: Array<{ id: string; label: string; active: boolean }>;
  valueUnit?: string;
}

async function setFlag(key: string, enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, key));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
}

describe("Custom-field filters (Epic #539)", () => {
  let app: FastifyInstance;
  let token: string;
  let tokenB: string;
  let idGrand: string;
  let idRegular: string;
  let idEmpty: string;

  beforeAll(async () => {
    app = await createServer();
    await app.ready();
    await ensureTestTenants();

    await setFlag(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, true);
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);

    // Definitions are stable across the suite — seeded once via the owner
    // pool (cross-tenant harness op).
    await db
      .delete(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.orgId, [ORG_A, ORG_B]));
    await db.insert(customFieldDefinitions).values([
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "segment",
        label: "Segment donateur",
        type: "picklist",
        sortOrder: 0,
        options: [
          { id: "opt_grand000", label: "Grand donateur", active: true, sortOrder: 0 },
          { id: "opt_regular0", label: "Régulier", active: true, sortOrder: 1 },
          { id: "opt_retired0", label: "Ancien segment", active: false, sortOrder: 2 },
        ],
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "board_member",
        label: "Membre du conseil",
        type: "boolean",
        sortOrder: 1,
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "capacity",
        label: "Capacité de don",
        type: "currency",
        sortOrder: 2,
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "last_review",
        label: "Dernière revue",
        type: "date",
        sortOrder: 3,
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "contact_notes",
        label: "Préférence de contact",
        type: "text",
        sortOrder: 4,
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "interests",
        label: "Centres d'intérêt",
        type: "multi_picklist",
        sortOrder: 5,
        options: [
          { id: "opt_env00000", label: "Environnement", active: true, sortOrder: 0 },
          { id: "opt_edu00000", label: "Éducation", active: true, sortOrder: 1 },
          { id: "opt_art00000", label: "Arts", active: true, sortOrder: 2 },
        ],
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "score",
        label: "Score interne",
        type: "number",
        sortOrder: 6,
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "private_notes",
        label: "Notes non filtrables",
        type: "text",
        sortOrder: 7,
        filterable: false,
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "health_note",
        label: "État de santé",
        type: "text",
        sortOrder: 10,
        sensitive: true,
        purposeText: "Adaptation des visites bénévoles",
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "old_segment",
        label: "Segment archivé",
        type: "picklist",
        sortOrder: 8,
        options: [{ id: "opt_dead0000", label: "Mort", active: true, sortOrder: 0 }],
        archivedAt: new Date(),
      },
      // Archived + later re-created under the same key (the unique index is
      // partial on archived_at IS NULL): the ACTIVE definition must win —
      // filtering on it is valid, never a custom_field_archived 400.
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "reborn",
        label: "Ancienne incarnation",
        type: "text",
        sortOrder: 9,
        archivedAt: new Date(),
      },
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "reborn",
        label: "Nouvelle incarnation",
        type: "text",
        sortOrder: 10,
      },
      // ORG_B has a SAME-KEY definition with different option ids — the
      // cross-tenant proof: org B's registry never resolves org A's options
      // and org B's data never matches org A's ids.
      {
        orgId: ORG_B,
        domain: "constituent",
        key: "segment",
        label: "Segment B",
        type: "picklist",
        sortOrder: 0,
        options: [{ id: "opt_bgrand00", label: "Grand B", active: true, sortOrder: 0 }],
      },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM pledges WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_documents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db
      .delete(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.orgId, [ORG_A, ORG_B]));

    await setFlag(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, false);
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);

    const cacheKeys = await redis.keys("customfields:*");
    if (cacheKeys.length > 0) await redis.del(...cacheKeys);

    await app.close();
  });

  beforeEach(async () => {
    await ensureTestTenants();
    await flagService.invalidate();
    await flagService.invalidateTenant(ORG_A);
    await flagService.invalidateTenant(ORG_B);

    // The 60s definition-catalog cache would otherwise leak between suites.
    const cacheKeys = await redis.keys("customfields:*");
    if (cacheKeys.length > 0) await redis.del(...cacheKeys);

    // Rate-limit state bleeds across tests otherwise (dash separator — see
    // filters.test.ts).
    const rlKeys = await redis.keys("fastify-rate-limit-*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    token = signToken(app);
    tokenB = signTokenB(app);

    await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM pledges WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_documents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);

    const currentYear = new Date().getFullYear();

    await withTenantContext(ORG_A, async (db) => {
      const rows = await db
        .insert(constituents)
        .values([
          {
            orgId: ORG_A,
            firstName: "Grand",
            lastName: "Donor",
            email: "grand@example.com",
            type: "donor",
            custom: {
              segment: "opt_grand000",
              board_member: true,
              capacity: 500000,
              last_review: "2026-01-15",
              contact_notes: "Prefers email contact",
              interests: ["opt_env00000", "opt_edu00000"],
              score: 42,
            },
          },
          {
            orgId: ORG_A,
            firstName: "Regular",
            lastName: "Donor",
            email: "regular@example.com",
            type: "donor",
            custom: {
              segment: "opt_regular0",
              board_member: false,
              capacity: 10000,
              last_review: "2025-06-01",
              contact_notes: "Prefers phone calls",
              interests: ["opt_art00000"],
              score: 7,
            },
          },
          {
            orgId: ORG_A,
            firstName: "Empty",
            lastName: "Custom",
            email: "empty@example.com",
            type: "donor",
            custom: {},
          },
        ])
        .returning({ id: constituents.id });

      idGrand = rows[0]!.id;
      idRegular = rows[1]!.id;
      idEmpty = rows[2]!.id;

      // Grand: gave LAST year only → LYBUNT. Regular: gave THIS year.
      await db.insert(donations).values([
        {
          orgId: ORG_A,
          constituentId: idGrand,
          amountCents: 10000,
          amountBaseCents: 10000,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(currentYear - 1, 5, 15),
        },
        {
          orgId: ORG_A,
          constituentId: idRegular,
          amountCents: 20000,
          amountBaseCents: 20000,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(currentYear, 1, 10),
        },
      ]);
    });

    await withTenantContext(ORG_B, async (db) => {
      await db.insert(constituents).values({
        orgId: ORG_B,
        firstName: "Tenant",
        lastName: "B",
        email: "tenant-b@example.com",
        type: "donor",
        custom: { segment: "opt_bgrand00" },
      });
    });
  });

  async function runFilter(
    query: object,
    extra: object = {},
    who: "A" | "B" = "A",
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/constituents/filter",
      headers: authHeader(who === "A" ? token : tokenB),
      payload: { query, ...extra },
    });
    return { status: response.statusCode, body: response.json() };
  }

  function resultIds(body: Record<string, unknown>): string[] {
    const data = (body.data as { data: Array<{ id: string }> }).data;
    return data.map((row) => row.id);
  }

  describe("JSONB resolver lanes", () => {
    it("picklist eq (containment) matches only the stored option id", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.segment", operator: "eq", value: "opt_grand000" }],
      });
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idGrand]);
    });

    it("picklist in matches any of the listed option ids", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [
          { field: "custom.segment", operator: "in", value: ["opt_grand000", "opt_regular0"] },
        ],
      });
      expect(status).toBe(200);
      expect(resultIds(body).sort()).toEqual([idGrand, idRegular].sort());
    });

    it("picklist neq excludes empty values (core-column semantics)", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.segment", operator: "neq", value: "opt_grand000" }],
      });
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idRegular]);
    });

    it("boolean eq and neq stay on the containment path", async () => {
      const eqTrue = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.board_member", operator: "eq", value: true }],
      });
      expect(eqTrue.status).toBe(200);
      expect(resultIds(eqTrue.body)).toEqual([idGrand]);

      const neqTrue = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.board_member", operator: "neq", value: true }],
      });
      expect(neqTrue.status).toBe(200);
      expect(resultIds(neqTrue.body)).toEqual([idRegular]);
    });

    it("currency values are EUR-scaled to cents before comparison", async () => {
      // gte 1000 EUR → 100000 cents: only Grand (500000) qualifies.
      const gte = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.capacity", operator: "gte", value: 1000 }],
      });
      expect(gte.status).toBe(200);
      expect(resultIds(gte.body)).toEqual([idGrand]);

      // between 50–200 EUR → 5000–20000 cents: only Regular (10000).
      const between = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.capacity", operator: "between", value: [50, 200] }],
      });
      expect(between.status).toBe(200);
      expect(resultIds(between.body)).toEqual([idRegular]);
    });

    it("number comparisons cast the JSONB value to numeric", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.score", operator: "gt", value: 10 }],
      });
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idGrand]);
    });

    it("date between keeps the boundary day inclusive", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [
          { field: "custom.last_review", operator: "between", value: ["2026-01-01", "2026-01-15"] },
        ],
      });
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idGrand]);
    });

    it("text contains runs a parameterized ILIKE", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.contact_notes", operator: "contains", value: "email" }],
      });
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idGrand]);
    });

    it("multi_picklist arrayContains = all, arrayOverlaps = any", async () => {
      const containsAll = await runFilter({
        operator: "AND",
        conditions: [
          {
            field: "custom.interests",
            operator: "arrayContains",
            value: ["opt_env00000", "opt_edu00000"],
          },
        ],
      });
      expect(containsAll.status).toBe(200);
      expect(resultIds(containsAll.body)).toEqual([idGrand]);

      const overlaps = await runFilter({
        operator: "AND",
        conditions: [
          {
            field: "custom.interests",
            operator: "arrayOverlaps",
            value: ["opt_art00000", "opt_env00000"],
          },
        ],
      });
      expect(overlaps.status).toBe(200);
      expect(resultIds(overlaps.body).sort()).toEqual([idGrand, idRegular].sort());
    });

    it("isNull / isNotNull express is-empty / has-a-value", async () => {
      const empty = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.segment", operator: "isNull" }],
      });
      expect(empty.status).toBe(200);
      expect(resultIds(empty.body)).toEqual([idEmpty]);

      const hasValue = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.segment", operator: "isNotNull" }],
      });
      expect(hasValue.status).toBe(200);
      expect(resultIds(hasValue.body).sort()).toEqual([idGrand, idRegular].sort());
    });

    it("composes with aggregate conditions and LYBUNT in one query", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [
          { field: "custom.segment", operator: "eq", value: "opt_grand000" },
          { field: "donations.totalAmount", operator: "gte", value: 50 },
        ],
        patterns: ["LYBUNT"],
      });
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idGrand]);
    });

    it("preview counts custom-field matches", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter/preview",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [{ field: "custom.segment", operator: "eq", value: "opt_grand000" }],
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.count).toBe(1);
    });
  });

  describe("validation and safety", () => {
    it("rejects injection-shaped field names as unknown fields", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [
          { field: "custom.seg'); DROP TABLE constituents;--", operator: "eq", value: "x" },
        ],
      });
      expect(status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain("Unknown field");
    });

    it("rejects suspicious values on custom text fields", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [
          { field: "custom.contact_notes", operator: "contains", value: "x'; DROP TABLE users;--" },
        ],
      });
      expect(status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain("Suspicious");
    });

    it("rejects a filterable=false field as unknown", async () => {
      const { status } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.private_notes", operator: "contains", value: "x" }],
      });
      expect(status).toBe(400);
    });

    it("rejects wrong operators for the field type", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.board_member", operator: "contains", value: "tr" }],
      });
      expect(status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain("Invalid operator");
    });

    it("returns the named 400 custom_field_archived for archived fields", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.old_segment", operator: "eq", value: "opt_dead0000" }],
      });
      expect(status).toBe(400);
      expect(body.title).toBe("custom_field_archived");
      expect(body.archived_fields).toEqual(["custom.old_segment"]);
    });

    it("resolves an archived-then-recreated key to the active definition", async () => {
      const { status, body } = await runFilter({
        operator: "AND",
        conditions: [{ field: "custom.reborn", operator: "isNull" }],
      });
      expect(status).toBe(200);
      // No fixture stores a `reborn` value → everyone is "empty".
      expect(resultIds(body).sort()).toEqual([idEmpty, idGrand, idRegular].sort());
    });

    it("treats custom fields as unknown when the custom-fields flag is off", async () => {
      await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
      try {
        const { status, body } = await runFilter({
          operator: "AND",
          conditions: [{ field: "custom.segment", operator: "eq", value: "opt_grand000" }],
        });
        expect(status).toBe(400);
        expect(JSON.stringify(body.errors)).toContain("Unknown field");
      } finally {
        await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
      }
    });

    it("never resolves another tenant's options or rows", async () => {
      // Org B's registry has its own `segment` definition; filtering with
      // org A's option id must return zero rows even though an org A
      // constituent carries it.
      const { status, body } = await runFilter(
        {
          operator: "AND",
          conditions: [{ field: "custom.segment", operator: "eq", value: "opt_grand000" }],
        },
        {},
        "B",
      );
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([]);
    });
  });

  describe("catalog enrichment (/filter/fields)", () => {
    it("serves core fields with i18n labels and custom fields with literal labels", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/fields",
        headers: authHeader(token),
      });
      expect(response.statusCode).toBe(200);
      const fields = response.json().data.fields as CatalogField[];

      const core = fields.find((f) => f.name === "constituent.firstName");
      expect(core).toMatchObject({
        label: "fields.constituent.firstName",
        labelKind: "i18n",
        category: "identity",
        nullable: false,
      });

      const aggregate = fields.find((f) => f.name === "donations.totalAmount");
      expect(aggregate).toMatchObject({
        labelKind: "i18n",
        category: "donation_history",
        valueUnit: "cents",
      });

      const segment = fields.find((f) => f.name === "custom.segment");
      expect(segment).toMatchObject({
        type: "string",
        label: "Segment donateur",
        labelKind: "literal",
        category: "custom",
        uiType: "picklist",
        nullable: true,
      });
      // All options ship, including inactive ones (persisted segments still
      // need their labels), with the active bit intact.
      expect(segment?.options).toHaveLength(3);
      expect(segment?.options?.find((o) => o.id === "opt_retired0")?.active).toBe(false);

      const capacity = fields.find((f) => f.name === "custom.capacity");
      expect(capacity).toMatchObject({ uiType: "currency", valueUnit: "cents" });

      // filterable=false and archived definitions never enter the catalog.
      expect(fields.find((f) => f.name === "custom.private_notes")).toBeUndefined();
      expect(fields.find((f) => f.name === "custom.old_segment")).toBeUndefined();
    });

    it("returns only the enriched core set for an org with no matching defs", async () => {
      await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, ORG_B));
      const cacheKeys = await redis.keys("customfields:*");
      if (cacheKeys.length > 0) await redis.del(...cacheKeys);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/constituents/filter/fields",
          headers: authHeader(tokenB),
        });
        expect(response.statusCode).toBe(200);
        const fields = response.json().data.fields as CatalogField[];
        expect(fields.length).toBeGreaterThan(0);
        expect(fields.every((f) => f.category !== "custom")).toBe(true);
        expect(fields.every((f) => f.labelKind === "i18n")).toBe(true);
      } finally {
        await db.insert(customFieldDefinitions).values({
          orgId: ORG_B,
          domain: "constituent",
          key: "segment",
          label: "Segment B",
          type: "picklist",
          sortOrder: 0,
          options: [{ id: "opt_bgrand00", label: "Grand B", active: true, sortOrder: 0 }],
        });
      }
    });
  });

  describe("sort and suggestions", () => {
    it("sorts by a custom number field with empties last", async () => {
      const { status, body } = await runFilter(
        {
          operator: "AND",
          conditions: [{ field: "constituent.createdAt", operator: "lte", value: "2100-01-01" }],
        },
        { sort: { field: "custom.score", order: "desc" } },
      );
      expect(status).toBe(200);
      expect(resultIds(body)).toEqual([idGrand, idRegular, idEmpty]);
    });

    it("suggests stored values for custom text fields", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/suggestions?field=custom.contact_notes&search=email",
        headers: authHeader(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(["Prefers email contact"]);
    });

    it("returns no suggestions for picklists (answered client-side from options)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/suggestions?field=custom.segment",
        headers: authHeader(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });

    it("never suggests stored values of sensitive (Art. 9) text fields", async () => {
      // Value enumeration via SELECT DISTINCT would sidestep the sensitive
      // fence — the field stays filterable, but suggestions answer empty.
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/suggestions?field=custom.health_note",
        headers: authHeader(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });
  });

  // The list + export routes share `parseFiltersParam`, which must resolve
  // the per-org registry — otherwise every `custom.<key>` condition 400s as
  // an unknown field even though POST /constituents/filter accepts it.
  describe("?filters= on the list and export routes", () => {
    it("GET /constituents honors a custom-field condition", async () => {
      const filters = encodeURIComponent(
        JSON.stringify({
          operator: "AND",
          conditions: [{ field: "custom.segment", operator: "eq", value: "opt_grand000" }],
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: `/v1/constituents?filters=${filters}`,
        headers: authHeader(token),
      });
      expect(response.statusCode).toBe(200);
      const ids = (response.json().data as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toEqual([idGrand]);
    });

    it("GET /constituents/export.csv honors a custom-field condition", async () => {
      const filters = encodeURIComponent(
        JSON.stringify({
          operator: "AND",
          conditions: [{ field: "custom.segment", operator: "eq", value: "opt_grand000" }],
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: `/v1/constituents/export.csv?filters=${filters}`,
        headers: authHeader(token),
      });
      expect(response.statusCode).toBe(200);
      const lines = response.body.split("\r\n").filter((line) => line.length > 0);
      // Header + exactly the one matching row.
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("Grand donateur");
    });
  });
});
