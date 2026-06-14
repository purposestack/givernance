/**
 * Notification fanout — cross-tenant isolation regression test (issue #430).
 *
 * The 2026-05-23 staging incident: a `donation.created` event in tenant A
 * fanned out notifications to org_admins of tenants B and C, because the
 * recipient query was `SELECT id FROM users WHERE role='org_admin'` with no
 * `eq(users.orgId, input.tenantId)`. The fanout relied on RLS for tenant
 * scoping, and a deploy misconfig (DATABASE_URL_APP pointing at the owner
 * role) silently bypassed RLS.
 *
 * The fix adds an explicit `eq(users.orgId, …)` to the recipient query. This
 * test pins that fix: two tenants, two org_admins, fire the fanout for
 * tenant A, assert that tenant B's admin received zero notification rows.
 *
 * Notes
 * - We do NOT depend on RLS to enforce isolation in this test. The point
 *   is that even with a hypothetically-broken RLS layer, the application
 *   code's explicit filter keeps tenants separated. So we use `db` (owner
 *   pool) for setup AND for verification — if the production code had an
 *   over-broad query, the verification SELECT would catch foreign-tenant
 *   leakage that RLS would otherwise hide.
 */

import { randomUUID } from "node:crypto";
import { notifications, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { fanoutNotifications } from "../../processors/notifications-fanout.js";

const TENANT_A_ID = "00000000-0000-0000-0000-000000000430";
const TENANT_B_ID = "00000000-0000-0000-0000-000000000431";
const ADMIN_A_ID = "00000000-0000-0000-0000-00000000a430";
const ADMIN_B_ID = "00000000-0000-0000-0000-00000000a431";
const OUTBOX_ID = "00000000-0000-0000-0000-00000000e430";
const DONATION_ID = "00000000-0000-0000-0000-00000000d430";

beforeAll(async () => {
  // Tenant A + tenant B, each with one org_admin.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${TENANT_A_ID}, 'Tenant A #430', ${`fanout-a-${randomUUID().slice(0, 8)}`}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET status = 'active'`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${TENANT_B_ID}, 'Tenant B #430', ${`fanout-b-${randomUUID().slice(0, 8)}`}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET status = 'active'`,
  );
  await db.execute(
    sql`INSERT INTO users (id, org_id, email, first_name, last_name, role, keycloak_id)
        VALUES (${ADMIN_A_ID}, ${TENANT_A_ID}, 'admin-a@430.test', 'Admin', 'A', 'org_admin', 'kc-admin-a-430')
        ON CONFLICT (id) DO UPDATE SET deleted_at = NULL`,
  );
  await db.execute(
    sql`INSERT INTO users (id, org_id, email, first_name, last_name, role, keycloak_id)
        VALUES (${ADMIN_B_ID}, ${TENANT_B_ID}, 'admin-b@430.test', 'Admin', 'B', 'org_admin', 'kc-admin-b-430')
        ON CONFLICT (id) DO UPDATE SET deleted_at = NULL`,
  );

  // Outbox event the fanout will dedupe against.
  await db
    .insert(outboxEvents)
    .values({
      id: OUTBOX_ID,
      tenantId: TENANT_A_ID,
      type: "donation.created",
      payload: { donationId: DONATION_ID, amountCents: 12300, currency: "EUR" },
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // Clean up everything the test inserted to keep CI rerunnable.
  await db.delete(notifications).where(eq(notifications.outboxEventId, OUTBOX_ID));
  await db.delete(outboxEvents).where(eq(outboxEvents.id, OUTBOX_ID));
  await db.delete(users).where(eq(users.id, ADMIN_A_ID));
  await db.delete(users).where(eq(users.id, ADMIN_B_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B_ID));
});

describe("notification fanout — cross-tenant isolation (issue #430)", () => {
  it("a donation.created event in tenant A inserts notifications only for tenant A's org_admins", async () => {
    await fanoutNotifications({
      outboxId: OUTBOX_ID,
      tenantId: TENANT_A_ID,
      type: "donation.created",
      payload: { donationId: DONATION_ID, amountCents: 12300, currency: "EUR" },
    });

    // Owner-pool SELECT: this would see foreign-tenant rows if the
    // fanout regressed. The audit predicates check both org_id and
    // user_id explicitly.
    const rows = await db
      .select({
        id: notifications.id,
        orgId: notifications.orgId,
        userId: notifications.userId,
      })
      .from(notifications)
      .where(eq(notifications.outboxEventId, OUTBOX_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(TENANT_A_ID);
    expect(rows[0]?.userId).toBe(ADMIN_A_ID);

    // The critical assertion — tenant B's admin received nothing.
    const tenantBRows = rows.filter((r) => r.userId === ADMIN_B_ID);
    expect(tenantBRows).toHaveLength(0);
  });

  it("the recipient resolver also scopes by orgId on the specific_user branch (campaign.postal_export_requested)", async () => {
    // Same event, but routed through specific_user. Plant a foreign
    // user_id (ADMIN_B from tenant B) as the requestedBy field — the
    // resolver MUST reject it because B's user does not belong to
    // tenant A.
    const SPOOF_OUTBOX = "00000000-0000-0000-0000-00000000e431";
    await db
      .insert(outboxEvents)
      .values({
        id: SPOOF_OUTBOX,
        tenantId: TENANT_A_ID,
        type: "campaign.postal_export_requested",
        payload: {
          requestedBy: ADMIN_B_ID, // foreign tenant user
          campaignId: "00000000-0000-0000-0000-0000000000c1",
          exportId: "00000000-0000-0000-0000-0000000000e1",
        },
      })
      .onConflictDoNothing();

    try {
      await fanoutNotifications({
        outboxId: SPOOF_OUTBOX,
        tenantId: TENANT_A_ID,
        type: "campaign.postal_export_requested",
        payload: {
          requestedBy: ADMIN_B_ID,
          campaignId: "00000000-0000-0000-0000-0000000000c1",
          exportId: "00000000-0000-0000-0000-0000000000e1",
        },
      });

      const rows = await db
        .select({ id: notifications.id, userId: notifications.userId })
        .from(notifications)
        .where(
          and(eq(notifications.outboxEventId, SPOOF_OUTBOX), eq(notifications.userId, ADMIN_B_ID)),
        );

      // ADMIN_B is in tenant B; the explicit `eq(users.orgId, tenantId)`
      // filter in `resolveRecipients` should reject the spoofed pointer.
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(notifications).where(eq(notifications.outboxEventId, SPOOF_OUTBOX));
      await db.delete(outboxEvents).where(eq(outboxEvents.id, SPOOF_OUTBOX));
    }
  });
});
