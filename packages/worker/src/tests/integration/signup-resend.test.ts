/**
 * Signup-resend processor — integration test (F3).
 *
 * Locks down the BullMQ-side handler that took over from the API's inline
 * `resendVerification` call after the timing-side-channel fix. Verifies
 * the three half-state recovery paths (pending verify, missing KC
 * credential, missing KC org) and the no-match silent path.
 */

import { randomUUID } from "node:crypto";
import { invitations, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";
import { processSignupResendPayload } from "../../processors/signup-resend.js";

// Distinct ID prefixes so this file doesn't collide with signup-email.test.ts
// fixtures, even when the workers package runs file-serially against the
// shared DB.
const ORG_PENDING = "00000000-0000-0000-0000-0000000000f1";
const INV_PENDING = "00000000-0000-0000-0000-0000000000f2";
const TOKEN_PENDING = "00000000-0000-0000-0000-0000000000f3";

const ORG_NO_KC_USER = "00000000-0000-0000-0000-0000000000f4";
const USER_NO_KC = "00000000-0000-0000-0000-0000000000f5";
const INV_NO_KC = "00000000-0000-0000-0000-0000000000f6";
const TOKEN_NO_KC = "00000000-0000-0000-0000-0000000000f7";

const ORG_NO_KC_ORG = "00000000-0000-0000-0000-0000000000f8";
const USER_KC_BOUND = "00000000-0000-0000-0000-0000000000f9";
const INV_NO_KC_ORG = "00000000-0000-0000-0000-0000000000fa";
const TOKEN_NO_KC_ORG = "00000000-0000-0000-0000-0000000000fb";

const ORG_DONE = "00000000-0000-0000-0000-0000000000fc";
const USER_DONE = "00000000-0000-0000-0000-0000000000fd";
const INV_DONE = "00000000-0000-0000-0000-0000000000fe";

const EMAIL_PENDING = "pending@resend.test";
const EMAIL_NO_KC = "nokc@resend.test";
const EMAIL_NO_KC_ORG = "noorg@resend.test";
const EMAIL_DONE = "done@resend.test";

const FUTURE = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

beforeAll(async () => {
  // Reset the SEC-10 per-email rate-limit buckets — EMAIL_PENDING is now
  // exercised three times in this file (rotate + the two issue-#575
  // metadata tests), which is exactly the hourly cap; without this reset a
  // second local run inside the TTL window would be silently rate-limited.
  const rateKeys = await redis.keys("signup:resend:email:*resend.test");
  if (rateKeys.length > 0) await redis.del(...rateKeys);

  // Pending-verify tenant: provisional, no users row, no KC org.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${ORG_PENDING}, 'Pending NGO', ${`resend-pending-${randomUUID().slice(0, 8)}`}, 'provisional', 'self_serve')
        ON CONFLICT (id) DO NOTHING`,
  );
  await db
    .insert(invitations)
    .values({
      id: INV_PENDING,
      orgId: ORG_PENDING,
      email: EMAIL_PENDING,
      role: "org_admin",
      token: TOKEN_PENDING,
      purpose: "signup_verification",
      expiresAt: FUTURE(),
    })
    .onConflictDoNothing();

  // Half-provisioned tenant (active) with a users row that has no keycloak_id —
  // mirrors the pre-#143 build's residual state.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, verified_at, keycloak_org_id)
        VALUES (${ORG_NO_KC_USER}, 'NoKC NGO', ${`resend-nokc-${randomUUID().slice(0, 8)}`}, 'active', 'self_serve', now(), ${randomUUID()})
        ON CONFLICT (id) DO NOTHING`,
  );
  await db
    .insert(users)
    .values({
      id: USER_NO_KC,
      orgId: ORG_NO_KC_USER,
      email: EMAIL_NO_KC,
      firstName: "No",
      lastName: "KC",
      role: "org_admin",
      firstAdmin: true,
      keycloakId: null,
    })
    .onConflictDoNothing();
  await db
    .insert(invitations)
    .values({
      id: INV_NO_KC,
      orgId: ORG_NO_KC_USER,
      email: EMAIL_NO_KC,
      role: "org_admin",
      token: TOKEN_NO_KC,
      purpose: "signup_verification",
      expiresAt: FUTURE(),
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();

  // No-Org half-state: user has a keycloak_id, but tenants.keycloak_org_id is
  // NULL — what the credential-only build left behind.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, verified_at)
        VALUES (${ORG_NO_KC_ORG}, 'NoOrg NGO', ${`resend-noorg-${randomUUID().slice(0, 8)}`}, 'active', 'self_serve', now())
        ON CONFLICT (id) DO NOTHING`,
  );
  await db
    .insert(users)
    .values({
      id: USER_KC_BOUND,
      orgId: ORG_NO_KC_ORG,
      email: EMAIL_NO_KC_ORG,
      firstName: "Has",
      lastName: "KC",
      role: "org_admin",
      firstAdmin: true,
      keycloakId: randomUUID(),
    })
    .onConflictDoNothing();
  await db
    .insert(invitations)
    .values({
      id: INV_NO_KC_ORG,
      orgId: ORG_NO_KC_ORG,
      email: EMAIL_NO_KC_ORG,
      role: "org_admin",
      token: TOKEN_NO_KC_ORG,
      purpose: "signup_verification",
      expiresAt: FUTURE(),
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();

  // Fully-provisioned tenant: active, users.keycloak_id and
  // tenants.keycloak_org_id both set. Resend must silently no-op.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, verified_at, keycloak_org_id)
        VALUES (${ORG_DONE}, 'Done NGO', ${`resend-done-${randomUUID().slice(0, 8)}`}, 'active', 'self_serve', now(), ${randomUUID()})
        ON CONFLICT (id) DO NOTHING`,
  );
  await db
    .insert(users)
    .values({
      id: USER_DONE,
      orgId: ORG_DONE,
      email: EMAIL_DONE,
      firstName: "Already",
      lastName: "Done",
      role: "org_admin",
      firstAdmin: true,
      keycloakId: randomUUID(),
    })
    .onConflictDoNothing();
  await db
    .insert(invitations)
    .values({
      id: INV_DONE,
      orgId: ORG_DONE,
      email: EMAIL_DONE,
      role: "org_admin",
      token: randomUUID(),
      purpose: "signup_verification",
      expiresAt: FUTURE(),
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // session_replication_role bypasses the audit-log immutability trigger
  // (same justification as the API signup.test cleanup hook).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    for (const orgId of [ORG_PENDING, ORG_NO_KC_USER, ORG_NO_KC_ORG, ORG_DONE]) {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, orgId));
      await tx.delete(users).where(eq(users.orgId, orgId));
      await tx.delete(invitations).where(eq(invitations.orgId, orgId));
      await tx.delete(tenants).where(eq(tenants.id, orgId));
    }
  });
});

describe("processSignupResendPayload", () => {
  it("rotates the token for a pending-verify tenant", async () => {
    const result = await processSignupResendPayload({ email: EMAIL_PENDING });
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.tenantId).toBe(ORG_PENDING);

    const [inv] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, INV_PENDING));
    expect(inv?.token).not.toBe(TOKEN_PENDING);
  });

  it("recovers the no-Keycloak-credential half-state by clearing accepted_at and rotating", async () => {
    const result = await processSignupResendPayload({ email: EMAIL_NO_KC });
    expect(result.matched).toBe(true);

    const [inv] = await db
      .select({ token: invitations.token, acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.id, INV_NO_KC));
    expect(inv?.token).not.toBe(TOKEN_NO_KC);
    expect(inv?.acceptedAt).toBeNull();
  });

  it("recovers the no-Keycloak-Organization half-state by clearing accepted_at and rotating", async () => {
    const result = await processSignupResendPayload({ email: EMAIL_NO_KC_ORG });
    expect(result.matched).toBe(true);

    const [inv] = await db
      .select({ token: invitations.token, acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.id, INV_NO_KC_ORG));
    expect(inv?.token).not.toBe(TOKEN_NO_KC_ORG);
    expect(inv?.acceptedAt).toBeNull();
  });

  it("is a silent no-op for a fully-provisioned tenant (no enumeration oracle)", async () => {
    const result = await processSignupResendPayload({ email: EMAIL_DONE });
    expect(result.matched).toBe(false);
  });

  it("is a silent no-op for an unknown email (no enumeration oracle)", async () => {
    const result = await processSignupResendPayload({
      email: `unknown-${randomUUID()}@resend.test`,
    });
    expect(result.matched).toBe(false);
  });

  // Issue #575 — this flow bypasses the outbox at enqueue time (F3 direct
  // BullMQ add), so the trace context rides in the job payload and must
  // land on the `tenant.signup_verification_resent` outbox insert.
  it("stamps a valid payload traceparent onto the outbox event", async () => {
    const traceparent = `00-${"12".repeat(16)}-${"34".repeat(8)}-01`;
    const result = await processSignupResendPayload({
      email: EMAIL_PENDING,
      metadata: { traceparent, tracestate: "vendor=resend-test" },
    });
    expect(result.matched).toBe(true);

    const { rows } = await db.execute<{
      metadata: { traceparent?: string; tracestate?: string } | null;
    }>(
      sql`SELECT metadata FROM outbox_events
          WHERE tenant_id = ${ORG_PENDING} AND type = 'tenant.signup_verification_resent'
          ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.metadata?.traceparent).toBe(traceparent);
    expect(rows[0]?.metadata?.tracestate).toBe("vendor=resend-test");
  });

  it("refuses to persist an invalid payload traceparent (second trust boundary)", async () => {
    const result = await processSignupResendPayload({
      email: EMAIL_PENDING,
      metadata: { traceparent: "garbage-from-redis" },
    });
    expect(result.matched).toBe(true);

    const { rows } = await db.execute<{ metadata: { traceparent?: string } | null }>(
      sql`SELECT metadata FROM outbox_events
          WHERE tenant_id = ${ORG_PENDING} AND type = 'tenant.signup_verification_resent'
          ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.metadata).toBeNull();
  });
});
