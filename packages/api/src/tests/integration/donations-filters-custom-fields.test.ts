/**
 * Integration tests for DONATION-domain custom-field filtering (Epic #539
 * fast-follow over the donations advanced-filter engine — flags
 * `donations.advanced_filters` × `donations.custom_fields`).
 *
 * Covers: every JSONB resolver lane on `donations.custom` (text ILIKE,
 * number, currency EUR→cents, date bounds, picklist containment,
 * multi_picklist overlap/contains, boolean, presence), stale-old-typed
 * value NULL-fencing, the named `custom_field_archived` 400 (top-level and
 * nested), the Art. 9 sensitive-suggestions fence, the flag matrix, the
 * §6 donor-custom-field veto (constituent-domain defs never leak into the
 * donations catalog/registry), and cross-tenant isolation.
 *
 * Runs under BOTH CI roles — routes resolve the registry and execute
 * through withTenantContext; the harness uses the owner pool from
 * tests/helpers/db.js (issue #455 split).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  constituents,
  customFieldDefinitions,
  donations,
  featureFlags,
} from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import type { FilterQuery } from "../../modules/constituents/filters/types.js";
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
  optionsKind?: string;
  valueUnit?: string;
}

async function setFlag(key: string, enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, key));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
}

async function clearCustomFieldsCache() {
  const cacheKeys = await redis.keys("customfields:*");
  if (cacheKeys.length > 0) await redis.del(...cacheKeys);
}

function filtersUrl(query: FilterQuery) {
  return `/v1/donations?filters=${encodeURIComponent(JSON.stringify(query))}`;
}

async function cleanup() {
  // Full dependency chain — other suites leave pledges / receipts /
  // allocations behind, which FK-block the constituents delete.
  await db.execute(sql`DELETE FROM pledge_installments WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM pledges WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM receipts WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM donation_allocations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM campaign_documents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
}

describe("Donations custom-field filters (Epic #539, donation domain)", () => {
  let app: FastifyInstance;
  let token: string;
  let tokenB: string;
  let dGala: string; // matched gift, gala channel, rich custom blob
  let dOnline: string; // unmatched gift, online channel
  let dEmpty: string; // empty custom blob
  let dB: string; // ORG_B decoy carrying its own same-key channel value

  beforeAll(async () => {
    app = await createServer();
    await app.ready();
    await ensureTestTenants();

    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS, true);
    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, true);

    // Definitions are stable across the suite — seeded once via the owner
    // pool (cross-tenant harness op).
    await db
      .delete(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.orgId, [ORG_A, ORG_B]));
    await db.insert(customFieldDefinitions).values([
      {
        orgId: ORG_A,
        domain: "donation",
        key: "channel",
        label: "Canal de collecte",
        type: "picklist",
        sortOrder: 0,
        options: [
          // Stored-array order deliberately ≠ sortOrder order: the catalog
          // must serve sortOrder order (same contract as constituents).
          { id: "opt_online00", label: "En ligne", active: true, sortOrder: 1 },
          { id: "opt_gala0000", label: "Gala", active: true, sortOrder: 0 },
          { id: "opt_legacy00", label: "Ancien canal", active: false, sortOrder: 2 },
        ],
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "matched",
        label: "Don doublé (matching)",
        type: "boolean",
        sortOrder: 1,
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "match_amount",
        label: "Montant du matching",
        type: "currency",
        sortOrder: 2,
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "ack_date",
        label: "Date de remerciement",
        type: "date",
        sortOrder: 3,
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "thank_you_note",
        label: "Note de remerciement",
        type: "text",
        sortOrder: 4,
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "themes",
        label: "Thématiques",
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
        domain: "donation",
        key: "intern_score",
        label: "Score interne",
        type: "number",
        sortOrder: 6,
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "private_ref",
        label: "Référence non filtrable",
        type: "text",
        sortOrder: 7,
        filterable: false,
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "hardship_note",
        label: "Situation particulière",
        type: "text",
        sortOrder: 8,
        sensitive: true,
        purposeText: "Suivi des dons en situation de précarité",
      },
      {
        orgId: ORG_A,
        domain: "donation",
        key: "old_channel",
        label: "Canal archivé",
        type: "picklist",
        sortOrder: 9,
        options: [{ id: "opt_dead0000", label: "Mort", active: true, sortOrder: 0 }],
        archivedAt: new Date(),
      },
      // §6 veto proof: a CONSTITUENT-domain definition for the same org must
      // NEVER surface in the donations registry or catalog.
      {
        orgId: ORG_A,
        domain: "constituent",
        key: "segment",
        label: "Segment donateur",
        type: "picklist",
        sortOrder: 0,
        options: [{ id: "opt_grand000", label: "Grand donateur", active: true, sortOrder: 0 }],
      },
      // ORG_B has a SAME-KEY donation definition with different option ids —
      // the cross-tenant proof.
      {
        orgId: ORG_B,
        domain: "donation",
        key: "channel",
        label: "Canal B",
        type: "picklist",
        sortOrder: 0,
        options: [{ id: "opt_bchan000", label: "Canal B", active: true, sortOrder: 0 }],
      },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await db
      .delete(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.orgId, [ORG_A, ORG_B]));

    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS, false);
    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, false);
    await clearCustomFieldsCache();

    await app.close();
  });

  beforeEach(async () => {
    await ensureTestTenants();
    await flagService.invalidate();
    await flagService.invalidateTenant(ORG_A);
    await flagService.invalidateTenant(ORG_B);

    // The 60s definition-catalog cache would otherwise leak between suites.
    await clearCustomFieldsCache();

    // Rate-limit state bleeds across tests otherwise (preview is 20/min).
    const rlKeys = await redis.keys("fastify-rate-limit-*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    token = signToken(app);
    tokenB = signTokenB(app);

    await cleanup();

    const [alice] = await db
      .insert(constituents)
      .values({ orgId: ORG_A, firstName: "Alice", lastName: "Martin", email: "alice@example.org" })
      .returning({ id: constituents.id });

    const inserted = await db
      .insert(donations)
      .values([
        {
          orgId: ORG_A,
          constituentId: alice!.id,
          amountCents: 5000,
          amountBaseCents: 5000,
          status: "cleared",
          donatedAt: new Date("2026-03-15T09:00:00Z"),
          custom: {
            channel: "opt_gala0000",
            matched: true,
            match_amount: 250000, // €2500 stored in cents
            ack_date: "2026-02-10",
            thank_you_note: "Sent handwritten card",
            themes: ["opt_env00000", "opt_edu00000"],
            intern_score: 42,
          },
        },
        {
          orgId: ORG_A,
          constituentId: alice!.id,
          amountCents: 2000,
          amountBaseCents: 2000,
          status: "cleared",
          donatedAt: new Date("2026-04-01T09:00:00Z"),
          custom: {
            channel: "opt_online00",
            matched: false,
            match_amount: 5000, // €50
            ack_date: "2025-11-01",
            thank_you_note: "Emailed thanks",
            themes: ["opt_art00000"],
            intern_score: 7,
          },
        },
        {
          orgId: ORG_A,
          constituentId: alice!.id,
          amountCents: 1000,
          amountBaseCents: 1000,
          status: "cleared",
          donatedAt: new Date("2026-05-01T09:00:00Z"),
          custom: {},
        },
      ])
      .returning({ id: donations.id });
    [dGala, dOnline, dEmpty] = inserted.map((r) => r.id) as [string, string, string];

    const [bDonor] = await db
      .insert(constituents)
      .values({ orgId: ORG_B, firstName: "Benoit", lastName: "Blanc", email: "b@org-b.org" })
      .returning({ id: constituents.id });
    const [donationB] = await db
      .insert(donations)
      .values({
        orgId: ORG_B,
        constituentId: bDonor!.id,
        amountCents: 5000,
        amountBaseCents: 5000,
        status: "cleared",
        donatedAt: new Date("2026-03-15T09:00:00Z"),
        // Carries ORG_A's option id ON PURPOSE (hand-tampered data) — org
        // A's filters must still never see this row.
        custom: { channel: "opt_gala0000" },
      })
      .returning({ id: donations.id });
    dB = donationB!.id;
  });

  const cond = (field: string, operator: string, value?: unknown): FilterQuery =>
    ({ operator: "AND", conditions: [{ field, operator, value }] }) as FilterQuery;

  async function listWith(
    query: FilterQuery,
    useToken = token,
  ): Promise<{ status: number; ids: string[]; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(query),
      headers: authHeader(useToken),
    });
    const body = res.json();
    const ids =
      res.statusCode === 200
        ? (body.data as Array<{ id: string }>).map((row) => row.id).sort()
        : [];
    return { status: res.statusCode, ids, body };
  }

  async function listIds(query: FilterQuery, useToken = token): Promise<string[]> {
    const { status, ids } = await listWith(query, useToken);
    expect(status).toBe(200);
    return ids;
  }

  // ── JSONB resolver lanes on donations.custom ─────────────────────────

  describe("JSONB resolver lanes", () => {
    it("picklist eq (GIN containment) matches only the stored option id", async () => {
      expect(await listIds(cond("custom.channel", "eq", "opt_gala0000"))).toEqual([dGala]);
    });

    it("picklist in matches any of the listed option ids", async () => {
      expect(await listIds(cond("custom.channel", "in", ["opt_gala0000", "opt_online00"]))).toEqual(
        [dGala, dOnline].sort(),
      );
    });

    it("picklist neq excludes empty values (core-column semantics)", async () => {
      expect(await listIds(cond("custom.channel", "neq", "opt_gala0000"))).toEqual([dOnline]);
    });

    it("boolean eq and neq stay on the containment path", async () => {
      expect(await listIds(cond("custom.matched", "eq", true))).toEqual([dGala]);
      expect(await listIds(cond("custom.matched", "neq", true))).toEqual([dOnline]);
    });

    it("currency values are EUR-scaled to cents before comparison", async () => {
      // gte €1000 → 100000 cents: only dGala (250000) qualifies.
      expect(await listIds(cond("custom.match_amount", "gte", 1000))).toEqual([dGala]);
      // between €40–€60 → 4000–6000 cents: only dOnline (5000).
      expect(await listIds(cond("custom.match_amount", "between", [40, 60]))).toEqual([dOnline]);
    });

    it("number comparisons cast the JSONB value to numeric", async () => {
      expect(await listIds(cond("custom.intern_score", "gt", 10))).toEqual([dGala]);
    });

    it("date between keeps the boundary day inclusive", async () => {
      expect(
        await listIds(cond("custom.ack_date", "between", ["2026-02-01", "2026-02-10"])),
      ).toEqual([dGala]);
    });

    it("text contains runs a parameterized ILIKE", async () => {
      expect(await listIds(cond("custom.thank_you_note", "contains", "handwritten"))).toEqual([
        dGala,
      ]);
    });

    it("multi_picklist arrayContains = all, arrayOverlaps = any", async () => {
      expect(
        await listIds(cond("custom.themes", "arrayContains", ["opt_env00000", "opt_edu00000"])),
      ).toEqual([dGala]);
      expect(
        await listIds(cond("custom.themes", "arrayOverlaps", ["opt_art00000", "opt_env00000"])),
      ).toEqual([dGala, dOnline].sort());
    });

    it("isNull / isNotNull express is-empty / has-a-value", async () => {
      expect(await listIds(cond("custom.channel", "isNull"))).toEqual([dEmpty]);
      expect(await listIds(cond("custom.channel", "isNotNull"))).toEqual([dGala, dOnline].sort());
    });

    it("composes with core donation lanes in one query", async () => {
      const query: FilterQuery = {
        operator: "AND",
        conditions: [
          { field: "custom.channel", operator: "eq", value: "opt_gala0000" },
          { field: "donation.amount", operator: "gte", value: 40 },
        ],
      } as FilterQuery;
      expect(await listIds(query)).toEqual([dGala]);
    });

    it("preview counts custom-field matches", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/donations/filter/preview",
        headers: authHeader(token),
        payload: { query: cond("custom.channel", "eq", "opt_gala0000") },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.count).toBe(1);
    });
  });

  // ── Stale old-typed values (archive-recreate flow) ───────────────────

  describe("stale old-typed values are NULL-fenced — no 500", () => {
    async function seedStaleBlob(blob: Record<string, string>) {
      // Seeded through the owner pool ON PURPOSE — the write validator
      // (correctly) refuses these, exactly like the pre-change rows the
      // archive-recreate type-change flow leaves behind.
      await db
        .update(donations)
        .set({ custom: blob })
        .where(and(eq(donations.id, dEmpty), eq(donations.orgId, ORG_A)));
    }

    it("number/currency filters treat a stale text value as NULL", async () => {
      await seedStaleBlob({ intern_score: "high", match_amount: "beaucoup" });
      expect(await listIds(cond("custom.intern_score", "gt", 3))).toEqual([dGala, dOnline].sort());
      expect(await listIds(cond("custom.match_amount", "gte", 40))).toEqual(
        [dGala, dOnline].sort(),
      );
    });

    it("date filters treat non-date and impossible-calendar values as NULL", async () => {
      await seedStaleBlob({ ack_date: "not a date" });
      expect(
        await listIds(cond("custom.ack_date", "between", ["2025-01-01", "2026-12-31"])),
      ).toEqual([dGala, dOnline].sort());

      await seedStaleBlob({ ack_date: "2026-02-30" });
      expect(
        await listIds(cond("custom.ack_date", "between", ["2025-01-01", "2026-12-31"])),
      ).toEqual([dGala, dOnline].sort());
    });
  });

  // ── Validation, archived, flags, fences ──────────────────────────────

  describe("validation and safety", () => {
    it("rejects injection-shaped field names as unknown fields", async () => {
      const { status, body } = await listWith(
        cond("custom.ch'); DROP TABLE donations;--", "eq", "x"),
      );
      expect(status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain("Unknown field");
    });

    it("rejects a filterable=false field as unknown", async () => {
      const { status } = await listWith(cond("custom.private_ref", "contains", "x"));
      expect(status).toBe(400);
    });

    it("rejects wrong operators for the field type", async () => {
      const { status, body } = await listWith(cond("custom.matched", "contains", "tr"));
      expect(status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain("Invalid operator");
    });

    it("returns the named 400 custom_field_archived on the list lane", async () => {
      const { status, body } = await listWith(cond("custom.old_channel", "eq", "opt_dead0000"));
      expect(status).toBe(400);
      expect(body.title).toBe("custom_field_archived");
      expect(body.archived_fields).toEqual(["custom.old_channel"]);
    });

    it("returns the named 400 for archived refs nested in subConditions (preview)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/donations/filter/preview",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [
              {
                field: "donation.amount",
                operator: "gte",
                value: 1,
                subConditions: {
                  operator: "OR",
                  conditions: [
                    { field: "custom.old_channel", operator: "eq", value: "opt_dead0000" },
                  ],
                },
              },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.title).toBe("custom_field_archived");
      expect(body.archived_fields).toEqual(["custom.old_channel"]);
    });

    it("treats custom fields as unknown when donations.custom_fields is off", async () => {
      await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, false);
      try {
        const { status, body } = await listWith(cond("custom.channel", "eq", "opt_gala0000"));
        expect(status).toBe(400);
        expect(JSON.stringify(body.errors)).toContain("Unknown field");
      } finally {
        await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, true);
      }
    });

    it("never resolves another tenant's options or rows", async () => {
      // Org B's registry has its own `channel` definition; org B filtering
      // with org A's option id must return zero rows — and org A's filters
      // never see org B's tampered decoy row either.
      expect(await listIds(cond("custom.channel", "eq", "opt_bchan000"), tokenB)).toEqual([]);
      const orgAIds = await listIds(cond("custom.channel", "eq", "opt_gala0000"));
      expect(orgAIds).toEqual([dGala]);
      expect(orgAIds).not.toContain(dB);
    });
  });

  // ── Catalog ──────────────────────────────────────────────────────────

  describe("catalog enrichment (/donations/filter/fields)", () => {
    it("serves custom fields with literal labels, uiType, ordered options and cents unit", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/donations/filter/fields",
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      const fields = res.json().data.fields as CatalogField[];

      const core = fields.find((f) => f.name === "donation.amount");
      expect(core).toMatchObject({ labelKind: "i18n", category: "donation", valueUnit: "cents" });

      const channel = fields.find((f) => f.name === "custom.channel");
      expect(channel).toMatchObject({
        type: "string",
        label: "Canal de collecte",
        labelKind: "literal",
        category: "custom",
        uiType: "picklist",
        nullable: true,
      });
      // No optionsKind on custom entries (constituents-catalog contract).
      expect(channel?.optionsKind).toBeUndefined();
      // All options ship (inactive included, active bit intact), in
      // sortOrder order — the seed stores them shuffled.
      expect(channel?.options?.map((o) => o.id)).toEqual([
        "opt_gala0000",
        "opt_online00",
        "opt_legacy00",
      ]);
      expect(channel?.options?.find((o) => o.id === "opt_legacy00")?.active).toBe(false);

      const matchAmount = fields.find((f) => f.name === "custom.match_amount");
      expect(matchAmount).toMatchObject({ uiType: "currency", valueUnit: "cents" });

      const themes = fields.find((f) => f.name === "custom.themes");
      expect(themes).toMatchObject({ type: "array", uiType: "multi_picklist" });

      // filterable=false and archived definitions never enter the catalog.
      expect(fields.find((f) => f.name === "custom.private_ref")).toBeUndefined();
      expect(fields.find((f) => f.name === "custom.old_channel")).toBeUndefined();
    });

    it("never serves DONOR (constituent-domain) custom fields — Epic #539 §6 veto", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/donations/filter/fields",
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      const fields = res.json().data.fields as CatalogField[];
      // `segment` is an ORG_A CONSTITUENT-domain definition.
      expect(fields.find((f) => f.name === "custom.segment")).toBeUndefined();

      // …and the engine rejects it too, as an unknown field.
      const { status, body } = await listWith(cond("custom.segment", "eq", "opt_grand000"));
      expect(status).toBe(400);
      expect(JSON.stringify(body.errors)).toContain("Unknown field");
    });

    it("drops custom fields from the catalog when donations.custom_fields is off", async () => {
      await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, false);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/v1/donations/filter/fields",
          headers: authHeader(token),
        });
        expect(res.statusCode).toBe(200);
        const fields = res.json().data.fields as CatalogField[];
        expect(fields.length).toBeGreaterThan(0);
        expect(fields.every((f) => f.category !== "custom")).toBe(true);
        expect(fields.every((f) => f.labelKind === "i18n")).toBe(true);
      } finally {
        await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, true);
      }
    });
  });

  // ── Suggestions ──────────────────────────────────────────────────────

  describe("suggestions", () => {
    it("suggests stored values for custom text fields (org-scoped DISTINCT)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/donations/filter/suggestions?field=custom.thank_you_note&search=handwritten",
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual(["Sent handwritten card"]);
    });

    it("returns no suggestions for picklists (answered client-side from options)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/donations/filter/suggestions?field=custom.channel",
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    });

    it("never suggests stored values of sensitive (Art. 9) text fields", async () => {
      // Value enumeration via SELECT DISTINCT would sidestep the sensitive
      // fence — the field stays filterable, but suggestions answer empty.
      const res = await app.inject({
        method: "GET",
        url: "/v1/donations/filter/suggestions?field=custom.hardship_note",
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    });
  });
});
