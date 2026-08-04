/**
 * Tenant-lifecycle processor — integration test (issue #575).
 *
 * First coverage for `processTenantLifecycle` (the nightly
 * provisional-admin expire pass, issue #113 / ADR-016 / doc 22 §3.1).
 * Pins the three branches — confirm, dispute-skip, not-yet-elapsed — the
 * DATA-7 idempotency claim, and the cron-variant trace synthesis (issue
 * #55): every outbox row emitted by one pass must carry a `traceparent`
 * whose trace-id is deterministic from the repeatable job id.
 */

import { createHash, randomUUID } from "node:crypto";
import { extractTraceId, TRACEPARENT_RE } from "@givernance/shared/lib/trace-context";
import {
  auditLogs,
  invitations,
  outboxEvents,
  tenantAdminDisputes,
  tenants,
  users,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { processTenantLifecycle } from "../../processors/tenant-lifecycle.js";

// Distinct ID prefix (…e1-…) so this file can't collide with the other
// worker fixtures on the shared test DB.
const ORG_EXPIRED = "00000000-0000-0000-0000-0000000000e1";
const USER_EXPIRED = "00000000-0000-0000-0000-0000000000e2";
const ORG_DISPUTED = "00000000-0000-0000-0000-0000000000e3";
const USER_DISPUTED = "00000000-0000-0000-0000-0000000000e4";
const ORG_FUTURE = "00000000-0000-0000-0000-0000000000e5";
const USER_FUTURE = "00000000-0000-0000-0000-0000000000e6";
// Second expired org — proves the trace is rooted once per PASS, not once
// per row: both confirmations must share the identical full traceparent
// (trace-id AND span-id), which a per-row synthesis regression would break
// (same deterministic trace-id, different random span-id).
const ORG_EXPIRED_2 = "00000000-0000-0000-0000-0000000000e7";
const USER_EXPIRED_2 = "00000000-0000-0000-0000-0000000000e8";

const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const JOB_ID = "repeat:tenant-lifecycle:test-run";

function makeJob(overrides: Partial<Pick<Job, "id" | "name">> = {}): Job {
  return {
    id: JOB_ID,
    name: "tenant.provisional-admin-expire",
    ...overrides,
  } as Job;
}

async function seedOrg(orgId: string, userId: string, provisionalUntil: Date): Promise<void> {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, verified_at)
        VALUES (${orgId}, 'Lifecycle NGO', ${`lifecycle-${randomUUID().slice(0, 8)}`}, 'active', 'self_serve', now())
        ON CONFLICT (id) DO NOTHING`,
  );
  // Upsert (not do-nothing) so an interrupted previous run — killed after
  // the confirm pass cleared `provisional_until` but before `afterAll`
  // deleted the fixtures — is healed on the next run instead of leaving
  // this file permanently red until a manual purge.
  await db
    .insert(users)
    .values({
      id: userId,
      orgId,
      email: `${userId}@lifecycle.test`,
      firstName: "First",
      lastName: "Admin",
      role: "org_admin",
      firstAdmin: true,
      provisionalUntil,
    })
    .onConflictDoUpdate({ target: users.id, set: { provisionalUntil } });
}

beforeAll(async () => {
  await seedOrg(ORG_EXPIRED, USER_EXPIRED, PAST);
  await seedOrg(ORG_EXPIRED_2, USER_EXPIRED_2, PAST);
  await seedOrg(ORG_DISPUTED, USER_DISPUTED, PAST);
  await seedOrg(ORG_FUTURE, USER_FUTURE, FUTURE);

  await db
    .insert(tenantAdminDisputes)
    .values({
      orgId: ORG_DISPUTED,
      provisionalAdminId: USER_DISPUTED,
      reason: "contested first-admin claim",
      resolution: null,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // session_replication_role bypasses the audit-log immutability trigger
  // (same justification as the other worker-test cleanup hooks).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    for (const orgId of [ORG_EXPIRED, ORG_EXPIRED_2, ORG_DISPUTED, ORG_FUTURE]) {
      await tx.delete(auditLogs).where(eq(auditLogs.orgId, orgId));
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, orgId));
      await tx.delete(tenantAdminDisputes).where(eq(tenantAdminDisputes.orgId, orgId));
      await tx.delete(invitations).where(eq(invitations.orgId, orgId));
      await tx.delete(users).where(eq(users.orgId, orgId));
      await tx.delete(tenants).where(eq(tenants.id, orgId));
    }
  });
});

describe("processTenantLifecycle", () => {
  it("ignores unknown job names without touching any row", async () => {
    await processTenantLifecycle(makeJob({ name: "tenant.some-other-job" }));

    const [row] = await db
      .select({ provisionalUntil: users.provisionalUntil })
      .from(users)
      .where(eq(users.id, USER_EXPIRED));
    expect(row?.provisionalUntil).not.toBeNull();
  });

  it("confirms an elapsed provisional admin — clears the window, emits outbox + audit", async () => {
    await processTenantLifecycle(makeJob());

    const [row] = await db
      .select({ provisionalUntil: users.provisionalUntil })
      .from(users)
      .where(eq(users.id, USER_EXPIRED));
    expect(row?.provisionalUntil).toBeNull();

    const events = await db
      .select({ payload: outboxEvents.payload, metadata: outboxEvents.metadata })
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, ORG_EXPIRED));
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toEqual({ tenantId: ORG_EXPIRED, userId: USER_EXPIRED });

    // Cron variant of issue #55: no inbound trace context exists, so the
    // processor roots one trace per expire pass — the trace-id must be the
    // SHA-256-derived id of the repeatable job id (deterministic), the
    // span-id random per synthesis.
    const traceparent = events[0]?.metadata?.traceparent;
    expect(traceparent).toMatch(TRACEPARENT_RE);
    const expectedTraceId = createHash("sha256").update(JOB_ID).digest("hex").slice(0, 32);
    expect(extractTraceId(traceparent)).toBe(expectedTraceId);

    // One trace per PASS, not per row: the second expired org's confirmation
    // must carry the IDENTICAL full traceparent (same span-id). A regression
    // to per-row synthesis keeps the trace-id (deterministic from the job
    // id) but rolls a fresh random span-id — this assertion catches it.
    const [event2] = await db
      .select({ metadata: outboxEvents.metadata })
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, ORG_EXPIRED_2));
    expect(event2?.metadata?.traceparent).toBe(traceparent);

    const { rows: audit } = await db.execute<{ action: string; resource_id: string }>(
      sql`SELECT action, resource_id FROM audit_logs
          WHERE org_id = ${ORG_EXPIRED} ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe("tenant.provisional_admin_confirmed");
    expect(audit[0]?.resource_id).toBe(USER_EXPIRED);
  });

  it("is idempotent — a second pass emits no duplicate outbox event (DATA-7)", async () => {
    // Two passes INSIDE this test so it stays meaningful under `.only` or
    // reordering — relying on the previous test's pass would let a
    // duplicate-emit regression slip through silently (review F4).
    await processTenantLifecycle(makeJob());
    await processTenantLifecycle(makeJob());

    const events = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, ORG_EXPIRED));
    expect(events.length).toBe(1);
  });

  it("skips an org with an open dispute — resolution stays manual", async () => {
    await processTenantLifecycle(makeJob());

    const [row] = await db
      .select({ provisionalUntil: users.provisionalUntil })
      .from(users)
      .where(eq(users.id, USER_DISPUTED));
    expect(row?.provisionalUntil).not.toBeNull();

    const events = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, ORG_DISPUTED));
    expect(events.length).toBe(0);
  });

  it("leaves a not-yet-elapsed provisional window untouched", async () => {
    await processTenantLifecycle(makeJob());

    const [row] = await db
      .select({ provisionalUntil: users.provisionalUntil })
      .from(users)
      .where(eq(users.id, USER_FUTURE));
    expect(row?.provisionalUntil).not.toBeNull();

    const events = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, ORG_FUTURE));
    expect(events.length).toBe(0);
  });
});
