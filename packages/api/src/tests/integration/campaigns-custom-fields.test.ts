/**
 * Campaign-domain custom-field values + member-sub-table projection
 * (Epic #539).
 *
 * Covers the value write path on POST/PATCH `/v1/campaigns` (merge-patch
 * semantics, 422 matrix, flag-off rejection), the definition-driven
 * response firewall on campaign list/detail, and the `constituentCustom`
 * projection on `GET /v1/campaigns/:id/constituents` (show_on_related ∧
 * ¬sensitive ∧ ¬archived, gated by `constituents.custom_fields`).
 *
 * Runs under BOTH CI roles — the `api-tests-app` (NOBYPASSRLS) job is the
 * tenant-isolation gate: routes set tenant context via `withTenantContext`;
 * this file uses the owner `db` from the helper only for fixture seeding
 * (definitions, member blobs, flag toggles) per issue #455.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { CustomFieldOption } from "@givernance/shared/custom-fields";
import {
  campaigns,
  constituents,
  customFieldDefinitions,
  featureFlags,
} from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { invalidateDefinitionsCache } from "../../modules/customization/lib/value-service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";
import { db } from "../helpers/db.js";

let app: FastifyInstance;
let memberId: string;

const OPT_POSTAL = "opt_postal01";
const OPT_RETIRED = "opt_retired1";
const OPT_GRAND = "opt_grand001";

const CHANNEL_OPTIONS: CustomFieldOption[] = [
  { id: OPT_POSTAL, label: "Postal", active: true, sortOrder: 0 },
  { id: OPT_RETIRED, label: "Retired", active: false, sortOrder: 1 },
];
const SEGMENT_OPTIONS: CustomFieldOption[] = [
  { id: OPT_GRAND, label: "Grand donateur", active: true, sortOrder: 0 },
];

const createdCampaignIds: string[] = [];

async function setFlag(key: string, enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, key));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
}

async function seedDef(seed: {
  domain: "constituent" | "campaign";
  key: string;
  type: "text" | "boolean" | "picklist" | "currency";
  options?: CustomFieldOption[];
  required?: boolean;
  showOnRelated?: boolean;
  sensitive?: boolean;
  purposeText?: string;
  archivedAt?: Date;
}) {
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
  });
  await invalidateDefinitionsCache(ORG_A);
}

async function deleteDefs(keys: string[]) {
  await db
    .delete(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.orgId, ORG_A), inArray(customFieldDefinitions.key, keys)));
  await invalidateDefinitionsCache(ORG_A);
}

async function createCampaign(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(signToken(app)),
    payload: { name: "Custom Fields Campaign", type: "nominative_postal", ...payload },
  });
  if (res.statusCode === 201) {
    createdCampaignIds.push(res.json<{ data: { id: string } }>().data.id);
  }
  return res;
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Fresh slate — the DB persists across runs.
  await db.execute(sql`DELETE FROM custom_field_definitions WHERE org_id = ${ORG_A}`);
  await invalidateDefinitionsCache(ORG_A);

  await seedDef({ domain: "campaign", key: "channel", type: "picklist", options: CHANNEL_OPTIONS });
  await seedDef({ domain: "campaign", key: "matched_funding", type: "boolean" });
  await seedDef({ domain: "campaign", key: "budget_extra", type: "currency" });
  await seedDef({
    domain: "constituent",
    key: "segment",
    type: "picklist",
    options: SEGMENT_OPTIONS,
    showOnRelated: true,
  });
  await seedDef({
    domain: "constituent",
    key: "health_notes",
    type: "text",
    sensitive: true,
    purposeText: "Accessibility support at events (Art. 9 explicit consent)",
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(signToken(app)),
    payload: { firstName: "Campaign", lastName: "Member", type: "donor" },
  });
  memberId = res.json<{ data: { id: string } }>().data.id;
  await db
    .update(constituents)
    .set({ custom: { segment: OPT_GRAND, health_notes: "confidential" } })
    .where(and(eq(constituents.id, memberId), eq(constituents.orgId, ORG_A)));
});

afterAll(async () => {
  await setFlag(FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS, false);
  await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, ORG_A));
  await invalidateDefinitionsCache(ORG_A);
  if (createdCampaignIds.length > 0) {
    await db
      .delete(campaigns)
      .where(and(eq(campaigns.orgId, ORG_A), inArray(campaigns.id, createdCampaignIds)));
  }
  await db
    .delete(constituents)
    .where(and(eq(constituents.id, memberId), eq(constituents.orgId, ORG_A)));
  await app.close();
});

describe("campaigns custom fields — flag OFF", () => {
  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS, false);
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
  });

  it("rejects a payload carrying custom values with 422 custom_fields_disabled", async () => {
    const res = await createCampaign({ custom: { channel: OPT_POSTAL } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ title: string }>().title).toBe("custom_fields_disabled");
  });

  it("creates normally without custom and the response carries no custom key", async () => {
    const res = await createCampaign({});
    expect(res.statusCode).toBe(201);
    expect("custom" in res.json<{ data: Record<string, unknown> }>().data).toBe(false);
  });
});

describe("campaigns custom fields — value writes (flag ON)", () => {
  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS, true);
  });

  it("creates with valid values and serialises them back", async () => {
    const res = await createCampaign({
      custom: { channel: OPT_POSTAL, matched_funding: true, budget_extra: 150_000 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { custom: Record<string, unknown> } }>().data.custom).toEqual({
      channel: OPT_POSTAL,
      matched_funding: true,
      budget_extra: 150_000,
    });
  });

  it("collects the 422 matrix in one response", async () => {
    const res = await createCampaign({
      custom: {
        nope: "x", // unknown_key
        matched_funding: "yes", // invalid_type
        channel: OPT_RETIRED, // inactive_option
        budget_extra: 10.5, // not_integer (currency = integer cents)
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
      matched_funding: "invalid_type",
      channel: "inactive_option",
      budget_extra: "not_integer",
    });
  });

  it("enforces required on CREATE and names the missing key", async () => {
    await seedDef({ domain: "campaign", key: "cost_center", type: "text", required: true });
    try {
      const missing = await createCampaign({});
      expect(missing.statusCode).toBe(422);
      expect(
        missing
          .json<{ custom_field_errors: { key: string; code: string }[] }>()
          .custom_field_errors.some(
            (e) => e.key === "cost_center" && e.code === "required_missing",
          ),
      ).toBe(true);

      const provided = await createCampaign({ custom: { cost_center: "CC-42" } });
      expect(provided.statusCode).toBe(201);
    } finally {
      await deleteDefs(["cost_center"]);
    }
  });

  it("PATCH is a merge-patch: absent keys untouched, explicit null clears", async () => {
    const created = await createCampaign({
      custom: { channel: OPT_POSTAL, matched_funding: true },
    });
    const campaignId = created.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(signToken(app)),
      payload: { custom: { matched_funding: null, budget_extra: 2_000 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { custom: Record<string, unknown> } }>().data.custom).toEqual({
      channel: OPT_POSTAL,
      budget_extra: 2_000,
    });
  });

  it("serialises on the list through the same definition firewall", async () => {
    const created = await createCampaign({ custom: { channel: OPT_POSTAL } });
    const campaignId = created.json<{ data: { id: string } }>().data.id;

    // Stray stored key must never reach the wire.
    await db
      .update(campaigns)
      .set({ custom: { channel: OPT_POSTAL, smuggled: "secret" } })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, ORG_A)));

    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?perPage=100",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const row = res
      .json<{ data: { id: string; custom?: Record<string, unknown> }[] }>()
      .data.find((c) => c.id === campaignId);
    expect(row?.custom).toEqual({ channel: OPT_POSTAL });
  });

  it("cross-tenant PATCH with custom payload is an indistinguishable 404 (ADR-019)", async () => {
    const created = await createCampaign({ custom: { channel: OPT_POSTAL } });
    const campaignId = created.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(signTokenB(app)),
      payload: { custom: { channel: null } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("campaign members — constituentCustom projection", () => {
  let campaignId: string;

  beforeAll(async () => {
    await setFlag(FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS, true);
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
    const created = await createCampaign({ name: "Members Projection" });
    campaignId = created.json<{ data: { id: string } }>().data.id;
    const added = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(signToken(app)),
      payload: { constituentIds: [memberId] },
    });
    expect(added.statusCode).toBe(201);
  });

  it("projects only show_on_related ∧ ¬sensitive keys on the member rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{
      data: { constituentId: string; constituentCustom?: Record<string, unknown> }[];
    }>().data;
    const member = rows.find((r) => r.constituentId === memberId);
    // `health_notes` is sensitive — structurally excluded from projection.
    expect(member?.constituentCustom).toEqual({ segment: OPT_GRAND });
  });

  it("omits constituentCustom entirely when constituents.custom_fields is off", async () => {
    await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, false);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/campaigns/${campaignId}/constituents`,
        headers: authHeader(signToken(app)),
      });
      expect(res.statusCode).toBe(200);
      for (const row of res.json<{ data: Record<string, unknown>[] }>().data) {
        expect("constituentCustom" in row).toBe(false);
      }
    } finally {
      await setFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, true);
    }
  });
});
