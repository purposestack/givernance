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
  donations,
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

  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.orgId, TENANT_ID));
  await db.delete(donations).where(eq(donations.orgId, TENANT_ID));
  await db.delete(constituents).where(eq(constituents.orgId, TENANT_ID));

  // Donation-domain definitions: one active sensitive, one ARCHIVED
  // sensitive (values outlive the definition — erasure must still reach
  // them), one non-sensitive (retained with the financial row).
  await db.insert(customFieldDefinitions).values([
    {
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
      orgId: TENANT_ID,
      domain: "donation",
      key: "channel_note",
      label: "Note de canal",
      type: "text",
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
});

// audit_logs is append-only (prevent_audit_log_mutation trigger) — rows
// from previous runs persist, so assertions below scope by `testStart`.
afterAll(async () => {
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
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("donor-secret");
    expect(serialized).not.toContain("treatment-related");
    expect(serialized).not.toContain("marie.dupont");
  });

  it("is idempotent on re-delivery", async () => {
    const result = await processGdprErasure(makeJob());
    expect(result).toMatchObject({ status: "erased", donationsStripped: 0 });
  });
});
