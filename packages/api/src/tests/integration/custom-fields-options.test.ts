/**
 * Picklist option lifecycle + merge + usage report (Epic #539, docs/35).
 *
 * Options: add / rename-in-place / deactivate / merged-option rules.
 * Merge: dry-run affected-row count via jsonb containment (soft-deleted
 * constituents excluded), real call → 202 + transactional outbox event
 * (the relay owns the BullMQ enqueue) + source marked `mergedInto`.
 * Undo: within the 30-day window the merge reverts (202 + undo outbox
 * event + source active again). Usage: fill counts and per-option
 * counts with the `'< 5'` k-anonymity mask.
 *
 * Runs under BOTH CI roles (issue #455): routes go through
 * `withTenantContext`; the owner `db` from the helper only seeds
 * constituents rows and toggles flags.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { CustomFieldValues } from "@givernance/shared/custom-fields";
import { CUSTOM_FIELD_EVENT_TYPES } from "@givernance/shared/jobs";
import { constituents, featureFlags, outboxEvents } from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, ORG_B, signToken } from "../helpers/auth.js";
import { db } from "../helpers/db.js";

let app: FastifyInstance;
const seededConstituentIds: string[] = [];

const ALL_FLAGS = [
  FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
  FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
  FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
] as const;

async function setAllFlags(enabled: boolean) {
  await db
    .update(featureFlags)
    .set({ enabled })
    .where(inArray(featureFlags.key, [...ALL_FLAGS]));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
}

async function cleanupCustomFieldRows() {
  await db.execute(sql`
    DELETE FROM outbox_events
    WHERE tenant_id IN (${ORG_A}, ${ORG_B})
      AND type IN (${CUSTOM_FIELD_EVENT_TYPES.OPTION_MERGE_REQUESTED}, ${CUSTOM_FIELD_EVENT_TYPES.OPTION_MERGE_UNDO_REQUESTED})
  `);
  await db.execute(sql`DELETE FROM custom_field_merge_undo WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM custom_field_definitions WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(
    sql`DELETE FROM customization_quota_overrides WHERE org_id IN (${ORG_A}, ${ORG_B})`,
  );
}

interface OptionData {
  id: string;
  label: string;
  active: boolean;
  sortOrder: number;
  mergedInto?: string;
  mergeId?: string;
  mergedAt?: string;
}

interface DefinitionData {
  id: string;
  key: string;
  type: string;
  options: OptionData[];
}

async function createField(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: { data: DefinitionData } & Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/custom-fields",
    headers: authHeader(signToken(app)),
    payload: { domain: "constituent", type: "picklist", ...payload },
  });
  return { status: res.statusCode, body: res.json() };
}

async function seedConstituent(custom: Record<string, unknown>, opts: { deleted?: boolean } = {}) {
  const [row] = await db
    .insert(constituents)
    .values({
      orgId: ORG_A,
      firstName: "CF",
      lastName: "Seed",
      custom: custom as CustomFieldValues,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: constituents.id });
  if (row) seededConstituentIds.push(row.id);
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
  if (seededConstituentIds.length > 0) {
    await db.delete(constituents).where(inArray(constituents.id, seededConstituentIds));
  }
  await cleanupCustomFieldRows();
  await app.close();
});

describe("option lifecycle", () => {
  it("creates a picklist with server-generated stable option ids", async () => {
    const created = await createField({
      key: "segment",
      label: "Segment donateur",
      options: [{ label: "Grand donateur" }, { label: "Régulier" }, { label: "Ami" }],
    });
    expect(created.status).toBe(201);
    const { options } = created.body.data;
    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option.id).toMatch(/^opt_[A-Za-z0-9_-]{8}$/);
      expect(option.active).toBe(true);
    }
    expect(options.map((o) => o.sortOrder)).toEqual([0, 1, 2]);
  });

  it("adds, renames in place, and deactivates options", async () => {
    const token = signToken(app);
    const created = await createField({
      key: "region",
      label: "Région",
      options: [{ label: "Nord" }],
    });
    const id = created.body.data.id;

    const added = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${id}/options`,
      headers: authHeader(token),
      payload: { label: "Sud" },
    });
    expect(added.statusCode).toBe(201);
    const afterAdd = added.json<{ data: DefinitionData }>().data.options;
    expect(afterAdd).toHaveLength(2);
    const sud = afterAdd.find((o) => o.label === "Sud");
    expect(sud?.sortOrder).toBe(1);

    // Rename-in-place: the id is stable, no stored value is touched.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${id}/options/${sud?.id}`,
      headers: authHeader(token),
      payload: { label: "Sud-Ouest" },
    });
    expect(renamed.statusCode).toBe(200);
    const renamedOption = renamed
      .json<{ data: DefinitionData }>()
      .data.options.find((o) => o.id === sud?.id);
    expect(renamedOption?.label).toBe("Sud-Ouest");

    const deactivated = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${id}/options/${sud?.id}`,
      headers: authHeader(token),
      payload: { active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(
      deactivated.json<{ data: DefinitionData }>().data.options.find((o) => o.id === sud?.id)
        ?.active,
    ).toBe(false);

    const missing = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${id}/options/opt_zzzzzzzz`,
      headers: authHeader(token),
      payload: { label: "Ghost" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("persists an option sortOrder PATCH verbatim without renumbering siblings", async () => {
    const token = signToken(app);
    const created = await createField({
      key: "priority_lane",
      label: "Priorité",
      options: [{ label: "Un" }, { label: "Deux" }, { label: "Trois" }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const [first, second, third] = created.body.data.options;

    // The FE's splice-and-renumber reorder (PR #550 MAJOR-5) PATCHes each
    // changed option's sortOrder individually and relies on the server
    // persisting the value VERBATIM. A server that clamped, renumbered,
    // or rejected the write would silently break option reordering while
    // only FE unit tests pin the contract — this is the API-side pin.
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${id}/options/${third?.id}`,
      headers: authHeader(token),
      payload: { sortOrder: 0 },
    });
    expect(res.statusCode).toBe(200);
    const options = res.json<{ data: DefinitionData }>().data.options;
    expect(options.find((o) => o.id === third?.id)?.sortOrder).toBe(0);
    // Siblings are untouched — renumbering is the CLIENT's job, one
    // PATCH per changed option.
    expect(options.find((o) => o.id === first?.id)?.sortOrder).toBe(0);
    expect(options.find((o) => o.id === second?.id)?.sortOrder).toBe(1);

    // And the persisted order survives a fresh catalog read.
    const list = await app.inject({
      method: "GET",
      url: "/v1/custom-fields?domain=constituent",
      headers: authHeader(token),
    });
    const persisted = list
      .json<{ data: DefinitionData[] }>()
      .data.find((d) => d.id === id)
      ?.options.find((o) => o.id === third?.id);
    expect(persisted?.sortOrder).toBe(0);
  });

  it("422s option routes on non-picklist definitions", async () => {
    const created = await createField({ key: "plain_text", label: "Texte", type: "text" });
    const res = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${created.body.data.id}/options`,
      headers: authHeader(signToken(app)),
      payload: { label: "Nope" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ title: string }>().title).toBe("not_a_picklist");
  });
});

let definitionId: string;
let sourceId: string;
let targetId: string;

describe("option merge", () => {
  beforeAll(async () => {
    const created = await createField({
      key: "friend_tag",
      label: "Cercle",
      options: [{ label: "Ami" }, { label: "Amis" }, { label: "Autre" }],
    });
    expect(created.status).toBe(201);
    definitionId = created.body.data.id;
    const options = created.body.data.options;
    targetId = options[0]?.id ?? "";
    sourceId = options[1]?.id ?? "";

    // 6 live holders of the source, 2 of the target, 1 soft-deleted
    // source holder that must NOT count.
    for (let i = 0; i < 6; i++) await seedConstituent({ friend_tag: sourceId });
    for (let i = 0; i < 2; i++) await seedConstituent({ friend_tag: targetId });
    await seedConstituent({ friend_tag: sourceId }, { deleted: true });
  });

  it("dry-run returns the live affected-row count without mutating anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge?dryRun=true`,
      headers: authHeader(signToken(app)),
      payload: { targetOptionId: targetId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { dryRun: boolean; affectedCount: number; mergeId: null } }>();
    expect(body.data).toEqual({
      dryRun: true,
      affectedCount: 6,
      mergeId: null,
      undoExpiresAt: null,
    });

    // Nothing changed: the source option is still active.
    const list = await app.inject({
      method: "GET",
      url: "/v1/custom-fields?domain=constituent",
      headers: authHeader(signToken(app)),
    });
    const def = list.json<{ data: DefinitionData[] }>().data.find((d) => d.id === definitionId);
    expect(def?.options.find((o) => o.id === sourceId)?.active).toBe(true);
  });

  it("rejects an invalid merge target (self or inactive)", async () => {
    const self = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge?dryRun=true`,
      headers: authHeader(signToken(app)),
      payload: { targetOptionId: sourceId },
    });
    expect(self.statusCode).toBe(422);
    expect(self.json<{ title: string }>().title).toBe("merge_target_invalid");
  });

  it("counts multi_picklist holders via array containment", async () => {
    const created = await createField({
      key: "interests",
      label: "Intérêts",
      type: "multi_picklist",
      options: [{ label: "Sport" }, { label: "Culture" }],
    });
    const defId = created.body.data.id;
    const [sport, culture] = created.body.data.options;
    for (let i = 0; i < 5; i++) await seedConstituent({ interests: [sport?.id] });
    await seedConstituent({ interests: [culture?.id, sport?.id] });

    const res = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${defId}/options/${sport?.id}/merge?dryRun=true`,
      headers: authHeader(signToken(app)),
      payload: { targetOptionId: culture?.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { affectedCount: number } }>().data.affectedCount).toBe(6);
  });
});

describe("usage report", () => {
  it("reports fill + per-option counts with the '< 5' k-anonymity mask and quota meters", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/custom-fields/usage?domain=constituent",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        domain: string;
        totalRows: number;
        quotas: {
          fieldsPerDomain: { limit: number; used: number };
          showOnRelatedFields: { limit: number; used: number };
        };
        fields: {
          key: string;
          filled: string;
          fillRatePercent: number | null;
          options: { id: string; count: string }[];
        }[];
      }[];
    }>();
    const domainReport = body.data.find((d) => d.domain === "constituent");
    expect(domainReport).toBeTruthy();
    expect(domainReport?.quotas.fieldsPerDomain.limit).toBe(10);
    expect(domainReport?.quotas.fieldsPerDomain.used).toBeGreaterThan(0);

    // friend_tag: 8 live holders (6 source + 2 target) → exact count;
    // per-option: 6 → exact, 2 → masked below the k-anonymity floor.
    const friendTag = domainReport?.fields.find((f) => f.key === "friend_tag");
    expect(friendTag?.filled).toBe("8");
    const counts = (friendTag?.options ?? []).map((o) => o.count).sort();
    expect(counts).toContain("6");
    expect(counts).toContain("< 5");
    expect(counts).toContain("0");

    const interests = domainReport?.fields.find((f) => f.key === "interests");
    expect(interests?.filled).toBe("6");
    const region = domainReport?.fields.find((f) => f.key === "region");
    expect(region?.filled).toBe("0");
    expect(region?.fillRatePercent).toBe(0);
  });

  it("survives a stale scalar under a multi_picklist key (archive-and-recreate residue)", async () => {
    // docs/35 §4: archiving a key and recreating it with a new type
    // leaves old-typed values in stored blobs. A scalar under a
    // now-multi_picklist key must not abort the per-option aggregation —
    // unguarded, `jsonb_array_elements_text` raises 22023 on the scalar
    // and the WHOLE usage report 500s for every admin of the org until
    // the stale rows are hand-cleaned.
    await seedConstituent({ interests: "opt_stalescal" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/custom-fields/usage?domain=constituent",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        domain: string;
        fields: { key: string; filled: string; options: { id: string; count: string }[] }[];
      }[];
    }>();
    const interests = body.data
      .find((d) => d.domain === "constituent")
      ?.fields.find((f) => f.key === "interests");
    // The stale row still counts as filled (the key IS present)…
    expect(interests?.filled).toBe("7");
    // …but per-option counts aggregate array-typed rows only: 6 sport
    // holders (exact) and 1 culture holder (k-masked), same as before
    // the stale scalar landed.
    const counts = (interests?.options ?? []).map((o) => o.count).sort();
    expect(counts).toEqual(["6", "< 5"].sort());
  });

  it("is org_admin-only", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/custom-fields/usage",
      headers: authHeader(signToken(app, { role: "viewer" })),
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * Declared AFTER the usage suite: the merge flips the seeded source
 * option, which would skew the usage counts asserted above.
 */
describe("option merge — execution + undo", () => {
  it("real merge → 202, marks the source merged, emits the transactional outbox event", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge`,
      headers: authHeader(signToken(app)),
      payload: { targetOptionId: targetId },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{
      data: {
        dryRun: boolean;
        affectedCount: number;
        mergeId: string;
        undoExpiresAt: string | null;
      };
    }>();
    expect(body.data.dryRun).toBe(false);
    expect(body.data.affectedCount).toBe(6);
    expect(body.data.mergeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.undoExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const list = await app.inject({
      method: "GET",
      url: "/v1/custom-fields?domain=constituent",
      headers: authHeader(signToken(app)),
    });
    const def = list.json<{ data: DefinitionData[] }>().data.find((d) => d.id === definitionId);
    const source = def?.options.find((o) => o.id === sourceId);
    expect(source?.active).toBe(false);
    expect(source?.mergedInto).toBe(targetId);
    // The undo handle rides the catalog so the settings surface can
    // offer "undo merge" beyond the original 202 response.
    expect(source?.mergeId).toBe(body.data.mergeId);
    expect(source?.mergedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The enqueue is NOT direct: the merge transaction wrote the outbox
    // row the relay turns into the deterministic backfill job.
    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, ORG_A),
          eq(outboxEvents.type, CUSTOM_FIELD_EVENT_TYPES.OPTION_MERGE_REQUESTED),
        ),
      );
    expect(event).toBeTruthy();
    expect(event?.payload).toMatchObject({
      mergeId: body.data.mergeId,
      definitionId,
      sourceOptionId: sourceId,
      targetOptionId: targetId,
    });
    expect((event?.payload as { requestedBy?: string }).requestedBy).toBeTruthy();

    // A merged option can be neither re-merged nor reactivated.
    const again = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge?dryRun=true`,
      headers: authHeader(signToken(app)),
      payload: { targetOptionId: targetId },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json<{ title: string }>().title).toBe("option_merged");

    const reactivate = await app.inject({
      method: "PATCH",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}`,
      headers: authHeader(signToken(app)),
      payload: { active: true },
    });
    expect(reactivate.statusCode).toBe(422);
    expect(reactivate.json<{ title: string }>().title).toBe("option_merged");

    // Undo with a wrong mergeId is rejected; the recorded one reverts the
    // merge (202 + undo outbox event + option active again).
    const wrongUndo = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge/${crypto.randomUUID()}/undo`,
      headers: authHeader(signToken(app)),
    });
    expect(wrongUndo.statusCode).toBe(422);
    expect(wrongUndo.json<{ title: string }>().title).toBe("merge_not_undoable");

    const undo = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge/${body.data.mergeId}/undo`,
      headers: authHeader(signToken(app)),
    });
    expect(undo.statusCode).toBe(202);
    expect(undo.json<{ data: { mergeId: string } }>().data.mergeId).toBe(body.data.mergeId);

    const [undoEvent] = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, ORG_A),
          eq(outboxEvents.type, CUSTOM_FIELD_EVENT_TYPES.OPTION_MERGE_UNDO_REQUESTED),
        ),
      );
    expect(undoEvent?.payload).toMatchObject({
      mergeId: body.data.mergeId,
      definitionId,
      sourceOptionId: sourceId,
      targetOptionId: targetId,
    });

    const afterUndo = await app.inject({
      method: "GET",
      url: "/v1/custom-fields?domain=constituent",
      headers: authHeader(signToken(app)),
    });
    const restored = afterUndo
      .json<{ data: DefinitionData[] }>()
      .data.find((d) => d.id === definitionId)
      ?.options.find((o) => o.id === sourceId);
    expect(restored?.active).toBe(true);
    expect(restored?.mergedInto).toBeUndefined();

    // Undone merge is spent — a second undo of the same mergeId 422s.
    const undoAgain = await app.inject({
      method: "POST",
      url: `/v1/custom-fields/${definitionId}/options/${sourceId}/merge/${body.data.mergeId}/undo`,
      headers: authHeader(signToken(app)),
    });
    expect(undoAgain.statusCode).toBe(422);
    expect(undoAgain.json<{ title: string }>().title).toBe("merge_not_undoable");
  });
});
