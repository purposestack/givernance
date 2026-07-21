/**
 * GDPR erasure processor integration test (Art. 17 — Epic #539 wiring).
 *
 * Pins the custom-field erasure mechanics from docs/35 §6:
 *   - constituent anonymisation wipes the `custom` blob (`= '{}'`) in the
 *     SAME update as the identifier placeholders;
 *   - donation-domain values whose definition is `sensitive = true`
 *     (archived ones included) are stripped from the donor's donations
 *     even though the financial rows are retained (Swiss CO legal hold);
 *   - non-sensitive donation values survive with the row;
 *   - the subject's `custom_field_merge_undo` rows are purged inside the
 *     erasure transaction (constituent-domain rows + sensitive
 *     donation-domain rows for the donor's donations), so a post-erasure
 *     option-merge undo can never resurrect pre-erasure values;
 *   - `merge_history` snapshots where the subject appears (survivor or
 *     merged side) have identifiers + custom blobs nulled while ids and
 *     counters survive (Art. 17 vs Art. 5(2) balance);
 *   - the audit row carries counts + definition keys only — never the
 *     erased values;
 *   - erasure is idempotent and NEVER feature-flag-gated (the
 *     custom-fields flags stay untouched/off throughout this file).
 */

import { randomUUID } from "node:crypto";
import {
  auditLogs,
  constituents,
  customFieldDefinitions,
  customFieldMergeUndo,
  donations,
  mergeHistory,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, gte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { processGdprErasure } from "../../processors/gdpr-erasure.js";

// Unique per test file — worker suites run in parallel, and the erasure
// audit rows written here are append-only, so sharing a tenant id with
// another file would break that file's tenant teardown (23503).
const TENANT_ID = "00000000-0000-0000-0000-000000539002";
const CONSTITUENT_ID = "00000000-0000-0000-0000-00000000c539";
const OTHER_CONSTITUENT_ID = "00000000-0000-0000-0000-00000000c540";
const DONATION_ID = "00000000-0000-0000-0000-00000000d539";
const OTHER_DONATION_ID = "00000000-0000-0000-0000-00000000d540";

// Definition ids referenced by the merge-undo purge fixtures.
const SENSITIVE_DEF_ID = "00000000-0000-0000-0000-00000000f101";
const CHANNEL_DEF_ID = "00000000-0000-0000-0000-00000000f102";
const CONST_DEF_ID = "00000000-0000-0000-0000-00000000f103";

// Merge-undo fixtures: only U_SUBJECT_CONST (constituent-domain row of
// the erased entity) and U_SUBJECT_SENSITIVE (sensitive donation-domain
// row on the subject's donation) may be purged.
const U_SUBJECT_CONST = "00000000-0000-0000-0000-00000000aa01";
const U_NEIGHBOUR_CONST = "00000000-0000-0000-0000-00000000aa02";
const U_SUBJECT_SENSITIVE = "00000000-0000-0000-0000-00000000aa03";
const U_SUBJECT_PLAIN = "00000000-0000-0000-0000-00000000aa04";
const U_OTHER_SENSITIVE = "00000000-0000-0000-0000-00000000aa05";

// merge_history fixtures.
const H_AS_SURVIVOR = "00000000-0000-0000-0000-00000000bb01";
const H_AS_MERGED = "00000000-0000-0000-0000-00000000bb02";
const H_UNRELATED = "00000000-0000-0000-0000-00000000bb03";
const THIRD_ID = "00000000-0000-0000-0000-00000000c541";
const FOURTH_ID = "00000000-0000-0000-0000-00000000c542";

function subjectSnapshot(marker: string) {
  return {
    id: CONSTITUENT_ID,
    firstName: "Marie",
    lastName: "Dupont",
    email: "marie.dupont@example.org",
    phone: "+33600000000",
    addressLine1: "1 rue de la Paix",
    city: "Paris",
    tags: ["vip"],
    custom: { note: `merge-secret-${marker}` },
    donationTotalCents: 5000,
    donationCount: 3,
  };
}

function neighbourSnapshot() {
  return {
    id: OTHER_CONSTITUENT_ID,
    firstName: "Untouched",
    lastName: "Neighbour",
    email: "neighbour@example.org",
    custom: { note: "neighbour-merge-note" },
    donationTotalCents: 1000,
  };
}

function makeJob(): Job<{
  orgId: string;
  constituentId: string;
  requestedBy: string;
  requestedAt: string;
}> {
  return {
    id: "gdpr-erasure-test",
    data: {
      orgId: TENANT_ID,
      constituentId: CONSTITUENT_ID,
      requestedBy: "test-admin",
      requestedAt: new Date().toISOString(),
    },
  } as unknown as Job<{
    orgId: string;
    constituentId: string;
    requestedBy: string;
    requestedAt: string;
  }>;
}

let testStart: Date;

beforeAll(async () => {
  testStart = new Date();
  const slug = `gdpr-erasure-${randomUUID().slice(0, 8)}`;
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${TENANT_ID}, 'Tenant #539 erasure', ${slug}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET status = 'active'`,
  );

  await db.delete(customFieldMergeUndo).where(eq(customFieldMergeUndo.orgId, TENANT_ID));
  await db.delete(mergeHistory).where(eq(mergeHistory.orgId, TENANT_ID));
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, TENANT_ID));
  await db.delete(donations).where(eq(donations.orgId, TENANT_ID));
  await db.delete(constituents).where(eq(constituents.orgId, TENANT_ID));

  // Donation-domain definitions: one active sensitive, one ARCHIVED
  // sensitive (values outlive the definition — erasure must still reach
  // them), one non-sensitive (retained with the financial row). Plus one
  // constituent-domain definition anchoring the merge-undo purge.
  await db.insert(customFieldDefinitions).values([
    {
      id: SENSITIVE_DEF_ID,
      orgId: TENANT_ID,
      domain: "donation",
      key: "health_context",
      label: "Contexte santé",
      type: "text",
      sensitive: true,
      purposeText: "Suivi de dons liés à un programme de santé",
    },
    {
      orgId: TENANT_ID,
      domain: "donation",
      key: "old_sensitive",
      label: "Ancien champ sensible",
      type: "text",
      sensitive: true,
      purposeText: "Historique",
      archivedAt: new Date(),
    },
    {
      id: CHANNEL_DEF_ID,
      orgId: TENANT_ID,
      domain: "donation",
      key: "channel_note",
      label: "Note de canal",
      type: "text",
    },
    {
      id: CONST_DEF_ID,
      orgId: TENANT_ID,
      domain: "constituent",
      key: "segment",
      label: "Segment",
      type: "picklist",
      options: [
        {
          id: "opt_srcsrc01",
          label: "Amis",
          active: false,
          sortOrder: 0,
          mergedInto: "opt_tgttgt01",
        },
        { id: "opt_tgttgt01", label: "Ami", active: true, sortOrder: 1 },
      ],
    },
  ]);

  await db.insert(constituents).values([
    {
      id: CONSTITUENT_ID,
      orgId: TENANT_ID,
      firstName: "Marie",
      lastName: "Dupont",
      email: "marie.dupont@example.org",
      phone: "+33600000000",
      addressLine1: "1 rue de la Paix",
      city: "Paris",
      tags: ["vip"],
      custom: { segment: "opt_aaaaaaaa", note: "donor-secret" },
    },
    {
      id: OTHER_CONSTITUENT_ID,
      orgId: TENANT_ID,
      firstName: "Untouched",
      lastName: "Neighbour",
      custom: { note: "neighbour-secret" },
    },
  ]);

  await db.insert(donations).values([
    {
      id: DONATION_ID,
      orgId: TENANT_ID,
      constituentId: CONSTITUENT_ID,
      amountCents: 5000,
      amountBaseCents: 5000,
      custom: {
        health_context: "treatment-related gift",
        old_sensitive: "legacy sensitive value",
        channel_note: "came via postal campaign",
      },
    },
    {
      id: OTHER_DONATION_ID,
      orgId: TENANT_ID,
      constituentId: OTHER_CONSTITUENT_ID,
      amountCents: 1000,
      amountBaseCents: 1000,
      custom: { health_context: "unrelated donor value" },
    },
  ]);

  // Option-merge undo store: the erasure transaction must purge ONLY the
  // subject's constituent-domain rows and the sensitive donation-domain
  // rows on the subject's donations — everything else stays restorable.
  const undoExpiry = new Date(Date.now() + 60_000);
  const undoBase = {
    orgId: TENANT_ID,
    sourceOptionId: "opt_srcsrc01",
    targetOptionId: "opt_tgttgt01",
    expiresAt: undoExpiry,
  };
  await db.insert(customFieldMergeUndo).values([
    {
      ...undoBase,
      id: U_SUBJECT_CONST,
      definitionId: CONST_DEF_ID,
      mergeId: randomUUID(),
      entityId: CONSTITUENT_ID,
      previousValue: "opt_srcsrc01",
    },
    {
      ...undoBase,
      id: U_NEIGHBOUR_CONST,
      definitionId: CONST_DEF_ID,
      mergeId: randomUUID(),
      entityId: OTHER_CONSTITUENT_ID,
      previousValue: "opt_srcsrc01",
    },
    {
      ...undoBase,
      id: U_SUBJECT_SENSITIVE,
      definitionId: SENSITIVE_DEF_ID,
      mergeId: randomUUID(),
      entityId: DONATION_ID,
      previousValue: "pre-merge sensitive value",
    },
    {
      ...undoBase,
      id: U_SUBJECT_PLAIN,
      definitionId: CHANNEL_DEF_ID,
      mergeId: randomUUID(),
      entityId: DONATION_ID,
      previousValue: "pre-merge channel value",
    },
    {
      ...undoBase,
      id: U_OTHER_SENSITIVE,
      definitionId: SENSITIVE_DEF_ID,
      mergeId: randomUUID(),
      entityId: OTHER_DONATION_ID,
      previousValue: "other donor pre-merge value",
    },
  ]);

  // merge_history snapshots: the subject appears once as survivor, once
  // as merged side; the third row is between two unrelated constituents
  // and must stay byte-identical.
  await db.insert(mergeHistory).values([
    {
      id: H_AS_SURVIVOR,
      orgId: TENANT_ID,
      survivorId: CONSTITUENT_ID,
      mergedId: THIRD_ID,
      mergedByUserId: "test-admin",
      survivorBefore: subjectSnapshot("survivor-before"),
      survivorAfter: subjectSnapshot("survivor-after"),
      mergedBefore: neighbourSnapshot(),
    },
    {
      id: H_AS_MERGED,
      orgId: TENANT_ID,
      survivorId: OTHER_CONSTITUENT_ID,
      mergedId: CONSTITUENT_ID,
      mergedByUserId: "test-admin",
      survivorBefore: neighbourSnapshot(),
      survivorAfter: neighbourSnapshot(),
      mergedBefore: subjectSnapshot("merged-before"),
    },
    {
      id: H_UNRELATED,
      orgId: TENANT_ID,
      survivorId: THIRD_ID,
      mergedId: FOURTH_ID,
      mergedByUserId: "test-admin",
      survivorBefore: neighbourSnapshot(),
      survivorAfter: neighbourSnapshot(),
      mergedBefore: neighbourSnapshot(),
    },
  ]);
});

// audit_logs is append-only (prevent_audit_log_mutation trigger) — rows
// from previous runs persist, so assertions below scope by `testStart`.
afterAll(async () => {
  await db.delete(customFieldMergeUndo).where(eq(customFieldMergeUndo.orgId, TENANT_ID));
  await db.delete(mergeHistory).where(eq(mergeHistory.orgId, TENANT_ID));
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, TENANT_ID));
  await db.delete(donations).where(eq(donations.orgId, TENANT_ID));
  await db.delete(constituents).where(eq(constituents.orgId, TENANT_ID));
});

describe("processGdprErasure", () => {
  it("anonymises the constituent and wipes custom in the same step", async () => {
    const result = await processGdprErasure(makeJob());
    expect(result).toMatchObject({ status: "erased", constituentId: CONSTITUENT_ID });

    const [row] = await db
      .select()
      .from(constituents)
      .where(and(eq(constituents.id, CONSTITUENT_ID), eq(constituents.orgId, TENANT_ID)));
    expect(row?.firstName).toBe("Erased");
    expect(row?.lastName).toBe("Erased");
    expect(row?.email).toBeNull();
    expect(row?.phone).toBeNull();
    expect(row?.addressLine1).toBeNull();
    expect(row?.city).toBeNull();
    expect(row?.tags).toEqual([]);
    expect(row?.custom).toEqual({});
    expect(row?.deletedAt).not.toBeNull();
  });

  it("strips sensitive donation values (archived defs included) and keeps the rest", async () => {
    const [donation] = await db
      .select()
      .from(donations)
      .where(and(eq(donations.id, DONATION_ID), eq(donations.orgId, TENANT_ID)));
    expect(donation?.custom).toEqual({ channel_note: "came via postal campaign" });
    // Financial row itself is retained (legal hold) — only values go.
    expect(donation?.amountCents).toBe(5000);
  });

  it("does not touch other constituents' rows or donations", async () => {
    const [neighbour] = await db
      .select()
      .from(constituents)
      .where(and(eq(constituents.id, OTHER_CONSTITUENT_ID), eq(constituents.orgId, TENANT_ID)));
    expect(neighbour?.firstName).toBe("Untouched");
    expect(neighbour?.custom).toEqual({ note: "neighbour-secret" });

    const [otherDonation] = await db
      .select()
      .from(donations)
      .where(and(eq(donations.id, OTHER_DONATION_ID), eq(donations.orgId, TENANT_ID)));
    expect(otherDonation?.custom).toEqual({ health_context: "unrelated donor value" });
  });

  it("writes a counts-only audit row — never the erased values", async () => {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, TENANT_ID),
          eq(auditLogs.action, "erasure"),
          gte(auditLogs.createdAt, testStart),
        ),
      );
    expect(rows).toHaveLength(1);
    const audit = rows[0];
    expect(audit?.resourceType).toBe("constituent");
    expect(audit?.resourceId).toBe(CONSTITUENT_ID);
    expect(audit?.newValues).toMatchObject({
      reason: "gdpr_erasure_request",
      customWiped: true,
      donationsSensitiveStripped: 1,
      // Merge-seam accounting: counts only, never the purged values.
      mergeUndoRowsPurged: 2,
      mergeHistoryRowsRedacted: 2,
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("donor-secret");
    expect(serialized).not.toContain("treatment-related");
    expect(serialized).not.toContain("marie.dupont");
    expect(serialized).not.toContain("pre-merge");
    expect(serialized).not.toContain("merge-secret");
  });

  it("purges the subject's merge-undo rows and keeps unrelated ones restorable", async () => {
    const remaining = await db
      .select({ id: customFieldMergeUndo.id })
      .from(customFieldMergeUndo)
      .where(eq(customFieldMergeUndo.orgId, TENANT_ID));
    const ids = remaining.map((row) => row.id);
    // Gone: the subject's constituent-domain row + the sensitive
    // donation-domain row on the subject's donation.
    expect(ids).not.toContain(U_SUBJECT_CONST);
    expect(ids).not.toContain(U_SUBJECT_SENSITIVE);
    // Kept: the neighbour's row, the subject's NON-sensitive donation
    // row (that value was retained with the financial row), and the
    // other donor's sensitive row.
    expect(ids).toContain(U_NEIGHBOUR_CONST);
    expect(ids).toContain(U_SUBJECT_PLAIN);
    expect(ids).toContain(U_OTHER_SENSITIVE);
  });

  it("redacts the erased party inside merge_history snapshots, preserving the audit skeleton", async () => {
    const [asSurvivor] = await db
      .select()
      .from(mergeHistory)
      .where(and(eq(mergeHistory.id, H_AS_SURVIVOR), eq(mergeHistory.orgId, TENANT_ID)));
    // Both survivor-side snapshots are redacted…
    for (const snapshot of [asSurvivor?.survivorBefore, asSurvivor?.survivorAfter]) {
      const blob = snapshot as Record<string, unknown>;
      expect(blob.firstName).toBeNull();
      expect(blob.lastName).toBeNull();
      expect(blob.email).toBeNull();
      expect(blob.phone).toBeNull();
      expect(blob.custom).toBeNull();
      expect(blob.tags).toBeNull();
      // …while ids + counters survive for Art. 5(2) accountability.
      expect(blob.id).toBe(CONSTITUENT_ID);
      expect(blob.donationTotalCents).toBe(5000);
      expect(blob.donationCount).toBe(3);
    }
    // The other party's snapshot on the same row is untouched.
    expect((asSurvivor?.mergedBefore as Record<string, unknown>).firstName).toBe("Untouched");

    const [asMerged] = await db
      .select()
      .from(mergeHistory)
      .where(and(eq(mergeHistory.id, H_AS_MERGED), eq(mergeHistory.orgId, TENANT_ID)));
    const mergedBefore = asMerged?.mergedBefore as Record<string, unknown>;
    expect(mergedBefore.firstName).toBeNull();
    expect(mergedBefore.custom).toBeNull();
    expect(mergedBefore.id).toBe(CONSTITUENT_ID);
    expect((asMerged?.survivorBefore as Record<string, unknown>).firstName).toBe("Untouched");

    // A merge between two unrelated constituents is byte-identical.
    const [unrelated] = await db
      .select()
      .from(mergeHistory)
      .where(and(eq(mergeHistory.id, H_UNRELATED), eq(mergeHistory.orgId, TENANT_ID)));
    expect(unrelated?.survivorBefore).toEqual(neighbourSnapshot());
    expect(unrelated?.mergedBefore).toEqual(neighbourSnapshot());

    // No redacted row still carries the subject's PII anywhere.
    for (const row of [asSurvivor, asMerged]) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("marie.dupont");
      expect(serialized).not.toContain("merge-secret");
    }
  });

  it("is idempotent on re-delivery", async () => {
    const result = await processGdprErasure(makeJob());
    expect(result).toMatchObject({ status: "erased", donationsStripped: 0 });
  });
});
