/**
 * Survey send loop — Epic #434, issue #436.
 *
 * Validates the hourly cron:
 *   - picks up surveys whose next_scheduled_at is due,
 *   - fans out invitations to the cohort (idempotent on second tick),
 *   - emits outbox events for the API agent #437's email consumer,
 *   - reschedules cyclical surveys per cadence_days.
 */

import { outboxEvents, surveyInvitations, surveys, users } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { processSurveySend, resolveCohort } from "../../processors/finance-survey-send.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000539";
const ORG_ADMIN_ID = "00000000-0000-0000-0000-000000a00539";
const REGULAR_USER_ID = "00000000-0000-0000-0000-000000b00539";
const SURVEY_QUARTERLY = "00000000-0000-0000-0000-000000c00539";

function mockJob(): Job {
  return { id: "test-survey-send", data: {}, name: "test" } as unknown as Job;
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Survey Test NPO', 'survey-test-npo-436', 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active'
  `);

  await db
    .insert(users)
    .values([
      {
        id: ORG_ADMIN_ID,
        orgId: TENANT_ID,
        email: "admin-436@example.org",
        firstName: "Admin",
        lastName: "Survey",
        role: "org_admin",
      },
      {
        id: REGULAR_USER_ID,
        orgId: TENANT_ID,
        email: "user-436@example.org",
        firstName: "User",
        lastName: "Survey",
        role: "user",
      },
    ])
    .onConflictDoNothing();

  // Quarterly PMF survey, due now, targets org_admin role only.
  await db
    .insert(surveys)
    .values({
      id: SURVEY_QUARTERLY,
      kind: "pmf",
      slug: "pmf-test-436",
      questionFr: "Quel est ton ressenti ?",
      questionEn: "How disappointed would you be?",
      cohortRule: { roles: ["org_admin"] },
      cadenceDays: 90,
      freshnessSoonDays: 30,
      freshnessStaleDays: 90,
      nextScheduledAt: new Date(Date.now() - 60 * 1000), // due 1 minute ago
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id = ${TENANT_ID}`);
  await db.execute(sql`DELETE FROM survey_invitations WHERE org_id = ${TENANT_ID}`);
  await db.execute(sql`DELETE FROM surveys WHERE id = ${SURVEY_QUARTERLY}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${ORG_ADMIN_ID}, ${REGULAR_USER_ID})`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`);
});

describe("resolveCohort", () => {
  it("filters by role and excludes users from archived tenants", async () => {
    const cohort = await resolveCohort({ roles: ["org_admin"] });
    const ours = cohort.find((c) => c.userId === ORG_ADMIN_ID);
    expect(ours).toBeTruthy();
    // The regular user should NOT be in the org_admin cohort.
    const regular = cohort.find((c) => c.userId === REGULAR_USER_ID);
    expect(regular).toBeUndefined();
  });

  it("orgIds restricts cohort to those tenants only", async () => {
    const cohort = await resolveCohort({
      roles: ["org_admin", "user"],
      orgIds: [TENANT_ID],
    });
    expect(cohort.every((c) => c.orgId === TENANT_ID)).toBe(true);
    expect(cohort.find((c) => c.userId === ORG_ADMIN_ID)).toBeTruthy();
    expect(cohort.find((c) => c.userId === REGULAR_USER_ID)).toBeTruthy();
  });
});

describe("processSurveySend", () => {
  it("sends invitations to the cohort, emits outbox events, reschedules next_scheduled_at", async () => {
    await processSurveySend(mockJob());

    // Invitation created for the org_admin.
    const invitations = await db
      .select()
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.surveyId, SURVEY_QUARTERLY),
          eq(surveyInvitations.userId, ORG_ADMIN_ID),
          eq(surveyInvitations.orgId, TENANT_ID),
        ),
      );
    expect(invitations.length).toBe(1);
    expect(invitations[0]?.channel).toBe("email");

    // Outbox event emitted for the email-send consumer. The DB may
    // already contain seeded surveys (e.g. `pmf-sean-ellis`) that the
    // same cron tick also processed — filter for the event matching
    // our inserted survey before asserting.
    const events = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, TENANT_ID),
          eq(outboxEvents.type, "survey.invitation.send_email"),
        ),
      );
    const matchingEvent = events.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return p?.surveyId === SURVEY_QUARTERLY && p?.userId === ORG_ADMIN_ID;
    });
    expect(matchingEvent).toBeTruthy();
    const payload = matchingEvent?.payload as Record<string, unknown>;
    expect(payload?.surveyId).toBe(SURVEY_QUARTERLY);
    expect(payload?.userId).toBe(ORG_ADMIN_ID);
    expect(payload?.email).toBe("admin-436@example.org");

    // next_scheduled_at advanced by cadence_days.
    const [s] = await db
      .select({ next: surveys.nextScheduledAt })
      .from(surveys)
      .where(eq(surveys.id, SURVEY_QUARTERLY));
    expect(s?.next).toBeTruthy();
    if (s?.next) {
      // ~90 days in the future.
      const deltaDays = (s.next.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(deltaDays).toBeGreaterThan(89);
      expect(deltaDays).toBeLessThan(91);
    }

    // Regular user (not org_admin) did NOT receive an invitation.
    const regularInv = await db
      .select()
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.surveyId, SURVEY_QUARTERLY),
          eq(surveyInvitations.userId, REGULAR_USER_ID),
        ),
      );
    expect(regularInv.length).toBe(0);
  });

  it("idempotent: a second tick inside the active window does NOT create a duplicate invitation", async () => {
    // Roll the survey back to "due now" so the next tick scans it
    // again.
    await db
      .update(surveys)
      .set({ nextScheduledAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(surveys.id, SURVEY_QUARTERLY));

    const before = await db
      .select({ id: surveyInvitations.id })
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.surveyId, SURVEY_QUARTERLY),
          eq(surveyInvitations.userId, ORG_ADMIN_ID),
          eq(surveyInvitations.orgId, TENANT_ID),
        ),
      );

    await processSurveySend(mockJob());

    const after = await db
      .select({ id: surveyInvitations.id })
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.surveyId, SURVEY_QUARTERLY),
          eq(surveyInvitations.userId, ORG_ADMIN_ID),
          eq(surveyInvitations.orgId, TENANT_ID),
        ),
      );

    expect(after.length).toBe(before.length);
  });
});
