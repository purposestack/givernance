/**
 * Donation-domain custom-field values + donor projection (Epic #539).
 *
 * Covers the value write path on POST/PATCH `/v1/donations` (merge-patch
 * semantics, 422 matrix, flag-off rejection), the definition-driven
 * response firewall (stray stored keys never reach the wire), and the
 * cross-domain `donorCustom` projection on donation list + detail
 * (`show_on_related ∧ ¬sensitive ∧ ¬archived`, erased donors project
 * nothing, hard cap 5, no per-row definition lookups).
 *
 * Runs under BOTH CI roles — the `api-tests-app` (NOBYPASSRLS) job is the
 * tenant-isolation gate: routes set tenant context via `withTenantContext`;
 * this file uses the owner `db` from the helper only for fixture seeding
 * (definitions, donor blobs, flag toggles) per issue #455.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { CustomFieldOption, CustomFieldValues } from "@givernance/shared/custom-fields";
import {
  constituents,
  customFieldDefinitions,
  donations,
  featureFlags,
} from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { invalidateDefinitionsCache } from "../../modules/customization/lib/value-service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";
import { db } from "../helpers/db.js";

// Wrap the value-service catalog reads with call counters so the list
// route's "one serializer per request, no per-row lookups" contract is a
// RED test if someone reintroduces an N+1. Everything delegates to the
// real implementation.
const { catalogCalls } = vi.hoisted(() => ({ catalogCalls: { active: 0, projectable: 0 } }));
vi.mock("../../modules/customization/lib/value-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/customization/lib/value-service.js")>();
  return {
    ...actual,
    getActiveDefinitions: async (...args: Parameters<typeof actual.getActiveDefinitions>) => {
      catalogCalls.active += 1;
      return actual.getActiveDefinitions(...args);
    },
    getProjectableDefinitions: async (
      ...args: Parameters<typeof actual.getProjectableDefinitions>
    ) => {
      catalogCalls.projectable += 1;
      return actual.getProjectableDefinitions(...args);
    },
  };
});

let app: FastifyInstance;
let donorId: string;

const OPT_WEB = "opt_web00001";
const OPT_OLD = "opt_old00001";
const OPT_GRAND = "opt_grand001";

const GIFT_SOURCE_OPTIONS: CustomFieldOption[] = [
  { id: OPT_WEB, label: "Website", active: true, sortOrder: 0 },
  { id: OPT_OLD, label: "Legacy", active: false, sortOrder: 1 },
];
const SEGMENT_OPTIONS: CustomFieldOption[] = [
  { id: OPT_GRAND, label: "Grand donateur", active: true, sortOrder: 0 },
];

async function setFlag(key: string, enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, key));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
}

interface DefSeed {
  domain: "constituent" | "donation" | "campaign";
  key: string;
  type:
    | "text"
    | "long_text"
    | "number"
    | "date"
    | "boolean"
    | "picklist"
    | "multi_picklist"
    | "currency";
  options?: CustomFieldOption[];
  required?: boolean;
  showOnRelated?: boolean;
  sensitive?: boolean;
  purposeText?: string;
  archivedAt?: Date;
  sortOrder?: number;
}

async function seedDef(seed: DefSeed) {
  await db.insert(customFieldDefinitions).values({
    orgId: ORG_A,
    domain: seed.domain,
    key: seed.key,
    label: seed.key,
    type: seed.type,
    options: seed.options ?? [],
    required: seed.required ?? false,
    showOnRelated: seed.showOnRelated ?? false,
    sensitive: seed.sensitive ?? false,
    purposeText: seed.purposeText ?? null,
    archivedAt: seed.archivedAt ?? null,
    sortOrder: seed.sortOrder ?? 0,
  });
  await invalidateDefinitionsCache(ORG_A);
}

async function deleteDefs(keys: string[]) {
  await db
    .delete(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.orgId, ORG_A), inArray(customFieldDefinitions.key, keys)));
  await invalidateDefinitionsCache(ORG_A);
}

async function createDonation(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/v1/donations",
    headers: authHeader(signToken(app)),
    payload: { constituentId: donorId, amountCents: 5000, ...payload },
  });
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Fresh slate — the DB persists across runs.
  await db.execute(sql`DELETE FROM custom_field_definitions WHERE org_id = ${ORG_A}`);
  await invalidateDefinitionsCache(ORG_A);

  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(signToken(app)),
    payload: { firstName: "Custom", lastName: "Donor", type: "donor" },
  });
  donorId = res.json<{ data: { id: string } }>().data.id;

  // Donation-domain registry.
  await seedDef({
    domain: "donation",
    key: "gift_source",
    type: "picklist",
    options: GIFT_SOURCE_OPTIONS,
  });
  await seedDef({ domain: "donation", key: "matched", type: "boolean" });
  await seedDef({ domain: "donation", key: "notes", type: "text" });
  // Constituent-domain registry (projection fixtures).
  await seedDef({
    domain: "constituent",
    key: "segment",
    type: "picklist",
    options: SEGMENT_OPTIONS,
    showOnRelated: true,
  });
  await seedDef({ domain: "constituent", key: "vip", type: "boolean", showOnRelated: true });
  await seedDef({
    domain: "constituent",
    key: "health_notes",
    type: "text",
    sensitive: true,
    purposeText: "Accessibility support at events (Art. 9 explicit consent)",
  });
  await seedDef({
    domain: "constituent",
    key: "old_field",
    type: "text",
    showOnRelated: true,
    archivedAt: new Date(),
  });

  // Donor blob seeded directly (the constituent value route is exercised in
  // its own test file); includes a sensitive and an archived key that must
  // never project.
  await db
    .update(constituents)
    .set({
      custom: { segment: OPT_GRAND, vip: true, health_notes: "wheelchair access", old_field: "x" },
    })
    .where(and(eq(constituents.id, donorId), eq(constituents.orgId, ORG_A)));
});

afterAll(async () => {
  await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, false);
  await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
  await db
    .delete(donations)
    .where(and(eq(donations.orgId, ORG_A), eq(donations.constituentId, donorId)));
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, ORG_A));
  await invalidateDefinitionsCache(ORG_A);
  await db
    .delete(constituents)
    .where(and(eq(constituents.id, donorId), eq(constituents.orgId, ORG_A)));
  await app.close();
});

describe("donations custom fields — flag OFF", () => {
  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, false);
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
  });

  it("rejects a payload carrying custom values with 422 custom_fields_disabled", async () => {
    const res = await createDonation({ custom: { gift_source: OPT_WEB } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ title: string }>().title).toBe("custom_fields_disabled");
  });

  it("creates normally without custom and the response carries no custom keys", async () => {
    const res = await createDonation({});
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: Record<string, unknown> }>();
    expect("custom" in body.data).toBe(false);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/donations/${body.data.id}`,
      headers: authHeader(signToken(app)),
    });
    const detailData = detail.json<{ data: Record<string, unknown> }>().data;
    expect("custom" in detailData).toBe(false);
    expect("donorCustom" in detailData).toBe(false);
  });
});

describe("donations custom fields — value writes (flag ON)", () => {
  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, true);
  });

  it("creates with valid values, normalising text and serialising back", async () => {
    const res = await createDonation({
      custom: { gift_source: OPT_WEB, matched: true, notes: "  major gift  " },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { custom: Record<string, unknown> } }>().data.custom).toEqual({
      gift_source: OPT_WEB,
      matched: true,
      notes: "major gift",
    });
  });

  it("collects the full 422 matrix in one response", async () => {
    const res = await createDonation({
      custom: {
        nope: 1, // unknown_key
        matched: "yes", // invalid_type
        gift_source: OPT_OLD, // inactive_option
        notes: "x".repeat(2001), // too_long
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{
      title: string;
      custom_field_errors: { key: string; code: string }[];
    }>();
    expect(body.title).toBe("custom_field_validation_failed");
    const byKey = Object.fromEntries(body.custom_field_errors.map((e) => [e.key, e.code]));
    expect(byKey).toEqual({
      nope: "unknown_key",
      matched: "invalid_type",
      gift_source: "inactive_option",
      notes: "too_long",
    });
  });

  it("rejects an unknown picklist option", async () => {
    const res = await createDonation({ custom: { gift_source: "opt_missing0" } });
    expect(res.statusCode).toBe(422);
    expect(
      res.json<{ custom_field_errors: { code: string }[] }>().custom_field_errors[0]?.code,
    ).toBe("unknown_option");
  });

  it("enforces required on CREATE only — existing rows are never retro-blocked", async () => {
    // Row created before the field became required.
    const before = await createDonation({ custom: { matched: false } });
    expect(before.statusCode).toBe(201);
    const donationId = before.json<{ data: { id: string } }>().data.id;

    await seedDef({ domain: "donation", key: "grant_ref", type: "text", required: true });
    try {
      const missing = await createDonation({});
      expect(missing.statusCode).toBe(422);
      expect(
        missing
          .json<{ custom_field_errors: { key: string; code: string }[] }>()
          .custom_field_errors.some((e) => e.key === "grant_ref" && e.code === "required_missing"),
      ).toBe(true);

      const provided = await createDonation({ custom: { grant_ref: "G-2026-01" } });
      expect(provided.statusCode).toBe(201);

      // Update path never enforces required.
      const patched = await app.inject({
        method: "PATCH",
        url: `/v1/donations/${donationId}`,
        headers: authHeader(signToken(app)),
        payload: { constituentId: donorId, amountCents: 5000, custom: { matched: true } },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json<{ data: { custom: Record<string, unknown> } }>().data.custom).toEqual({
        matched: true,
      });
    } finally {
      await deleteDefs(["grant_ref"]);
    }
  });

  it("PATCH is a merge-patch: absent keys untouched, explicit null clears", async () => {
    const created = await createDonation({
      custom: { gift_source: OPT_WEB, matched: true, notes: "keep me" },
    });
    const donationId = created.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(signToken(app)),
      payload: {
        constituentId: donorId,
        amountCents: 5000,
        custom: { matched: null, gift_source: OPT_WEB },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { custom: Record<string, unknown> } }>().data.custom).toEqual({
      gift_source: OPT_WEB,
      notes: "keep me",
    });
  });

  it("never serialises stored keys that have no active definition (response firewall)", async () => {
    const created = await createDonation({ custom: { matched: true } });
    const donationId = created.json<{ data: { id: string } }>().data.id;

    // Stray key smuggled straight into the blob (simulates an archived
    // definition or a legacy writer) — it must survive in storage but
    // never reach the wire.
    await db
      .update(donations)
      .set({ custom: { matched: true, smuggled: "secret" } })
      .where(and(eq(donations.id, donationId), eq(donations.orgId, ORG_A)));

    const detail = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(signToken(app)),
    });
    expect(detail.json<{ data: { custom: Record<string, unknown> } }>().data.custom).toEqual({
      matched: true,
    });
  });

  it("cross-tenant PATCH with custom payload is an indistinguishable 404 (ADR-019)", async () => {
    const created = await createDonation({ custom: { matched: true } });
    const donationId = created.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(signTokenB(app)),
      payload: { constituentId: donorId, amountCents: 5000, custom: { matched: false } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("donations — donorCustom projection", () => {
  let donationId: string;

  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, true);
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
    const created = await createDonation({ custom: { matched: true } });
    donationId = created.json<{ data: { id: string } }>().data.id;
  });

  it("projects only show_on_related ∧ ¬sensitive ∧ ¬archived keys on detail", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: { donorCustom: Record<string, unknown>; custom: Record<string, unknown> };
    }>().data;
    // sensitive `health_notes` and archived `old_field` are structurally excluded.
    expect(data.donorCustom).toEqual({ segment: OPT_GRAND, vip: true });
    expect(data.custom).toEqual({ matched: true });
  });

  it("projects on list rows without per-row catalog lookups (no N+1)", async () => {
    catalogCalls.active = 0;
    catalogCalls.projectable = 0;
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations?constituentId=${donorId}&perPage=50`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ data: { donorCustom?: Record<string, unknown> }[] }>().data;
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.donorCustom).toEqual({ segment: OPT_GRAND, vip: true });
    }
    // One catalog read per serializer per REQUEST — not per row.
    expect(catalogCalls.active).toBe(1);
    expect(catalogCalls.projectable).toBe(1);
  });

  it("omits donorCustom when constituents.custom_fields is off (independent of the donation flag)", async () => {
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/donations/${donationId}`,
        headers: authHeader(signToken(app)),
      });
      const data = res.json<{ data: Record<string, unknown> }>().data;
      expect("donorCustom" in data).toBe(false);
      expect(data.custom).toEqual({ matched: true });
    } finally {
      await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
    }
  });

  it("caps the projection at 5 keys", async () => {
    const capKeys = ["sr_3", "sr_4", "sr_5", "sr_6"];
    for (const [i, key] of capKeys.entries()) {
      // segment + vip already project — these bring the org to 6 eligible defs.
      await seedDef({
        domain: "constituent",
        key,
        type: "text",
        showOnRelated: true,
        sortOrder: 10 + i,
      });
    }
    const blob: CustomFieldValues = { segment: OPT_GRAND, vip: true };
    for (const key of capKeys) blob[key] = "v";
    await db
      .update(constituents)
      .set({ custom: blob })
      .where(and(eq(constituents.id, donorId), eq(constituents.orgId, ORG_A)));

    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/donations/${donationId}`,
        headers: authHeader(signToken(app)),
      });
      const donorCustom = res.json<{ data: { donorCustom: Record<string, unknown> } }>().data
        .donorCustom;
      expect(Object.keys(donorCustom)).toHaveLength(5);
    } finally {
      await deleteDefs(capKeys);
      await db
        .update(constituents)
        .set({
          custom: {
            segment: OPT_GRAND,
            vip: true,
            health_notes: "wheelchair access",
            old_field: "x",
          },
        })
        .where(and(eq(constituents.id, donorId), eq(constituents.orgId, ORG_A)));
    }
  });

  it("an erased (soft-deleted) donor projects nothing", async () => {
    await db
      .update(constituents)
      .set({ deletedAt: new Date() })
      .where(and(eq(constituents.id, donorId), eq(constituents.orgId, ORG_A)));
    try {
      const detail = await app.inject({
        method: "GET",
        url: `/v1/donations/${donationId}`,
        headers: authHeader(signToken(app)),
      });
      expect(
        detail.json<{ data: { donorCustom: Record<string, unknown> } }>().data.donorCustom,
      ).toEqual({});

      const list = await app.inject({
        method: "GET",
        url: `/v1/donations?constituentId=${donorId}`,
        headers: authHeader(signToken(app)),
      });
      const rows = list.json<{ data: { donorCustom: Record<string, unknown> }[] }>().data;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.donorCustom).toEqual({});
      }
    } finally {
      await db
        .update(constituents)
        .set({ deletedAt: null })
        .where(and(eq(constituents.id, donorId), eq(constituents.orgId, ORG_A)));
    }
  });
});
