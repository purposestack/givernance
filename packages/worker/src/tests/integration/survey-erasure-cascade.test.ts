/**
 * Survey erasure-cascade integration test (Epic #434, issue #439).
 *
 * Pins the GDPR Art. 17 cascade behaviour that turns a tenant
 * `user.soft_deleted` outbox event into:
 *   - N rows in `survey_invitations` with `user_id` flipped to NULL
 *   - N rows in `audit_logs` with `action='erasure'`,
 *     `resource_type='survey_invitation'`, the affected invitation id,
 *     and `newValues.reason = 'user_erasure_cascade'`.
 * Idempotent re-delivery: a second cascade for the same user emits a
 * single summary "noop" audit row instead of per-row entries.
 */

import { randomUUID } from "node:crypto";
import { auditLogs, surveyInvitations, surveys, tenants, users } from "@givernance/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { cascadeSurveyErasure } from "../../processors/survey-erasure-cascade.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000439";
const USER_ID = "00000000-0000-0000-0000-00000000a439";
const SURVEY_ID = "00000000-0000-0000-0000-00000000c439";
const OUTBOX_ID = "00000000-0000-0000-0000-00000000e439";

const INV_IDS = [
  "00000000-0000-0000-0000-00000000b001",
  "00000000-0000-0000-0000-00000000b002",
  "00000000-0000-0000-0000-00000000b003",
];

beforeAll(async () => {
  // Tenant — mirror the raw-SQL pattern from notifications-fanout-isolation
  // to stay tolerant of any tenant-column drift between branches.
  const slug = `survey-erasure-${randomUUID().slice(0, 8)}`;
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${TENANT_ID}, 'Tenant #439', ${slug}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET status = 'active'`,
  );

  await db
    .insert(users)
    .values({
      id: USER_ID,
      orgId: TENANT_ID,
      email: `user-${USER_ID}@439.test`,
      firstName: "Erasure",
      lastName: "Subject",
      role: "user",
      keycloakId: `kc-${USER_ID}`,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { deletedAt: null, keycloakId: `kc-${USER_ID}` },
    });

  // Survey definition (platform-level — owner pool).
  await db
    .insert(surveys)
    .values({
      id: SURVEY_ID,
      kind: "nps",
      slug: `nps-erasure-${randomUUID().slice(0, 8)}`,
      questionFr: "Sur 10, recommanderiez-vous Givernance ?",
      questionEn: "On a 0–10 scale, how likely are you to recommend Givernance?",
      options: {},
      cohortRule: {},
      cadenceDays: 90,
      freshnessSoonDays: 90,
      freshnessStaleDays: 180,
      responseTarget: 100,
    })
    .onConflictDoNothing();

  // Three invitations for the same user.
  for (const id of INV_IDS) {
    await db
      .insert(surveyInvitations)
      .values({
        id,
        surveyId: SURVEY_ID,
        userId: USER_ID,
        orgId: TENANT_ID,
        channel: "email",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .onConflictDoUpdate({
        target: surveyInvitations.id,
        set: { userId: USER_ID, deletedAt: null },
      });
  }
});

afterAll(async () => {
  // audit_logs is immutable by trigger (audit_logs_immutable) per
  // GDPR Art. 5(1)(f) — bypass with a session-scoped DISABLE/ENABLE
  // ONLY in test cleanup to drop the cascade rows this test wrote.
  await db.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable`);
  try {
    await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.orgId, TENANT_ID), eq(auditLogs.action, "erasure")));
  } finally {
    await db.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable`);
  }
  await db.delete(surveyInvitations).where(eq(surveyInvitations.surveyId, SURVEY_ID));
  await db.delete(surveys).where(eq(surveys.id, SURVEY_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("cascadeSurveyErasure — user.soft_deleted fanout", () => {
  it("is a no-op for unrelated event types", async () => {
    const result = await cascadeSurveyErasure({
      outboxId: OUTBOX_ID,
      tenantId: TENANT_ID,
      type: "donation.created",
      payload: { userId: USER_ID, orgId: TENANT_ID },
    });
    expect(result).toEqual({ matched: false, invitationsNulled: 0 });
  });

  it("throws on a malformed payload (relay re-delivers)", async () => {
    await expect(
      cascadeSurveyErasure({
        outboxId: OUTBOX_ID,
        tenantId: TENANT_ID,
        type: "user.soft_deleted",
        payload: { userId: 123 as unknown as string, orgId: TENANT_ID },
      }),
    ).rejects.toThrow(/malformed payload/);
  });

  it("rejects a tenantId/orgId mismatch (cross-tenant safety)", async () => {
    await expect(
      cascadeSurveyErasure({
        outboxId: OUTBOX_ID,
        tenantId: TENANT_ID,
        type: "user.soft_deleted",
        payload: { userId: USER_ID, orgId: "00000000-0000-0000-0000-000000000bad" },
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("NULLs every pending invitation for the user and emits one audit row per invitation", async () => {
    const result = await cascadeSurveyErasure({
      outboxId: OUTBOX_ID,
      tenantId: TENANT_ID,
      type: "user.soft_deleted",
      payload: { userId: USER_ID, orgId: TENANT_ID },
    });

    expect(result).toEqual({ matched: true, invitationsNulled: INV_IDS.length });

    // Every invitation row exists, but user_id is now NULL.
    const invs = await db
      .select({ id: surveyInvitations.id, userId: surveyInvitations.userId })
      .from(surveyInvitations)
      .where(eq(surveyInvitations.surveyId, SURVEY_ID));
    expect(invs).toHaveLength(INV_IDS.length);
    expect(invs.every((row) => row.userId === null)).toBe(true);

    // One audit_logs row per invitation, all with the expected shape.
    const audits = await db
      .select({
        resourceId: auditLogs.resourceId,
        resourceType: auditLogs.resourceType,
        action: auditLogs.action,
        newValues: auditLogs.newValues,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, TENANT_ID), eq(auditLogs.action, "erasure")));
    expect(audits).toHaveLength(INV_IDS.length);
    for (const row of audits) {
      expect(row.resourceType).toBe("survey_invitation");
      expect(INV_IDS).toContain(row.resourceId);
      expect(row.newValues).toMatchObject({
        userId: USER_ID,
        reason: "user_erasure_cascade",
      });
    }
  });

  it("is idempotent — a re-delivery emits a single summary noop audit row", async () => {
    const before = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, TENANT_ID), eq(auditLogs.action, "erasure")));

    const result = await cascadeSurveyErasure({
      outboxId: OUTBOX_ID,
      tenantId: TENANT_ID,
      type: "user.soft_deleted",
      payload: { userId: USER_ID, orgId: TENANT_ID },
    });
    expect(result).toEqual({ matched: true, invitationsNulled: 0 });

    const after = await db
      .select({
        id: auditLogs.id,
        resourceId: auditLogs.resourceId,
        newValues: auditLogs.newValues,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, TENANT_ID), eq(auditLogs.action, "erasure")));

    expect(after.length).toBe(before.length + 1);
    const noopRow = after.find(
      (row) =>
        row.resourceId === null &&
        typeof row.newValues === "object" &&
        row.newValues !== null &&
        (row.newValues as Record<string, unknown>).outcome === "noop",
    );
    expect(noopRow).toBeTruthy();

    // Verify invitations are still NULL'd (idempotent => unchanged).
    const stillNulled = await db
      .select({ id: surveyInvitations.id })
      .from(surveyInvitations)
      .where(and(eq(surveyInvitations.surveyId, SURVEY_ID), isNull(surveyInvitations.userId)));
    expect(stillNulled).toHaveLength(INV_IDS.length);
  });
});
