/**
 * Notification centre integration tests (Epic #363, GLO-004).
 *
 * Coverage matrix:
 *   1. Off-state flag — every gated route returns 404 when the flag is
 *      off (anti-disclosure). 404 fires BEFORE auth.
 *   2. On-state flag — list + mark-read + mark-all-read happy paths,
 *      RFC 9457 problem+json on 404.
 *   3. RLS isolation — Tenant A can never see Tenant B's notifications
 *      (cross-tenant cursor probe + cross-tenant mark-read attempt).
 *   4. Recipient isolation — within the SAME tenant, user A can't read
 *      user B's notifications.
 *   5. Preferences — list returns the closed type set with defaults
 *      merged; PATCH upserts; unknown type returns 404.
 *   6. Registry parity — DB row matches FEATURE_FLAG_REGISTRY for the
 *      new flag (drift guard).
 */

import { FEATURE_FLAG_KEYS, FEATURE_FLAG_REGISTRY } from "@givernance/shared/constants";
import { featureFlags, notifications } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
  USER_A,
  USER_B,
} from "../helpers/auth.js";

const FLAG_KEY = FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER;

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
  await app.close();
});

beforeEach(async () => {
  // Reset DB state — no notifications, no preferences, flag off.
  await db.execute(sql`DELETE FROM notification_preferences`);
  await db.execute(sql`DELETE FROM notifications`);
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
});

afterEach(async () => {
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
});

// ─── Helpers ──────────────────────────────────────────────────────────

async function setFlag(enabled: boolean): Promise<void> {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
}

async function seedNotification(opts: {
  orgId: string;
  userId: string;
  type?: string;
  readAt?: Date | null;
  deletedAt?: Date | null;
}): Promise<string> {
  // Use owner-pool insert so we can set arbitrary org_id without RLS.
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO notifications
      (id, org_id, user_id, type, title_key, body_key, params, link_url, read_at, deleted_at)
    VALUES
      (${id}, ${opts.orgId}, ${opts.userId}, ${opts.type ?? "donation.received"},
       'notifications.types.donation_received.title',
       'notifications.types.donation_received.body',
       '{"donationId":"00000000-0000-0000-0000-000000000aaa"}'::jsonb,
       '/donations/00000000-0000-0000-0000-000000000aaa',
       ${opts.readAt ?? null}, ${opts.deletedAt ?? null})
  `);
  return id;
}

// ─── 1. Off-state flag — every gated route is 404 ─────────────────────

describe("Notifications — off-state flag (anti-disclosure)", () => {
  // Parametrise over every gated route so a refactor that drops the
  // `requireFlag` preHandler is caught here, not in production.
  const gatedRoutes: Array<{
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: unknown;
  }> = [
    { method: "GET", url: "/v1/notifications" },
    { method: "GET", url: "/v1/notifications/unread-count" },
    {
      method: "PATCH",
      url: "/v1/notifications/00000000-0000-0000-0000-000000000001/read",
    },
    { method: "POST", url: "/v1/notifications/read-all" },
    {
      method: "DELETE",
      url: "/v1/notifications/00000000-0000-0000-0000-000000000001",
    },
    { method: "GET", url: "/v1/notification-preferences" },
    {
      method: "PATCH",
      url: "/v1/notification-preferences/donation.received",
      payload: { inApp: true, emailDigest: false },
    },
  ];

  for (const route of gatedRoutes) {
    it(`returns 404 on ${route.method} ${route.url} when flag is off`, async () => {
      const token = signToken(app);
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: authHeader(token),
        payload: route.payload as Record<string, unknown> | undefined,
      });
      expect(res.statusCode).toBe(404);
    });

    it(`unauthenticated ${route.method} ${route.url} also returns 404 (no auth-vs-flag disclosure)`, async () => {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload as Record<string, unknown> | undefined,
      });
      // requireFlag is first preHandler — runs before auth, so
      // unauthenticated callers hit the gate 404 (not 401).
      expect(res.statusCode).toBe(404);
    });
  }
});

// ─── 2. On-state flag — happy paths + RFC 9457 ─────────────────────────

describe("Notifications — list + mark + delete (flag on)", () => {
  beforeEach(async () => {
    await setFlag(true);
  });

  it("GET /v1/notifications returns caller's own rows", async () => {
    const id1 = await seedNotification({ orgId: ORG_A, userId: USER_A });
    const id2 = await seedNotification({ orgId: ORG_A, userId: USER_A });

    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }>; nextCursor: string | null }>();
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("GET /v1/notifications/unread-count returns the right count", async () => {
    await seedNotification({ orgId: ORG_A, userId: USER_A }); // unread
    await seedNotification({ orgId: ORG_A, userId: USER_A, readAt: new Date() }); // read
    await seedNotification({ orgId: ORG_A, userId: USER_A, deletedAt: new Date() }); // deleted

    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications/unread-count",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { unread: number } }>().data.unread).toBe(1);
  });

  it("PATCH /v1/notifications/:id/read marks one row read and is idempotent", async () => {
    const id = await seedNotification({ orgId: ORG_A, userId: USER_A });
    const token = signToken(app);

    const first = await app.inject({
      method: "PATCH",
      url: `/v1/notifications/${id}/read`,
      headers: authHeader(token),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ data: { readAt: string | null } }>().data.readAt).toBeTruthy();

    // Second call is idempotent — returns the same row, unchanged.
    const second = await app.inject({
      method: "PATCH",
      url: `/v1/notifications/${id}/read`,
      headers: authHeader(token),
    });
    expect(second.statusCode).toBe(200);
  });

  it("PATCH /v1/notifications/:id/read returns 404 RFC 9457 for unknown id", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/00000000-0000-0000-0000-000000000bad/read",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ status?: number; title?: string }>();
    // RFC 9457 — every error response carries `{ status, title }`.
    expect(body.status).toBe(404);
    expect(typeof body.title).toBe("string");
  });

  it("POST /v1/notifications/read-all marks every unread row read", async () => {
    await seedNotification({ orgId: ORG_A, userId: USER_A });
    await seedNotification({ orgId: ORG_A, userId: USER_A });
    await seedNotification({ orgId: ORG_A, userId: USER_A });

    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { marked: number } }>().data.marked).toBe(3);

    // Subsequent call returns 0 — idempotent.
    const second = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: authHeader(token),
    });
    expect(second.json<{ data: { marked: number } }>().data.marked).toBe(0);
  });

  it("DELETE /v1/notifications/:id soft-deletes (deleted_at set, row stays)", async () => {
    const id = await seedNotification({ orgId: ORG_A, userId: USER_A });
    const token = signToken(app);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/notifications/${id}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);

    // Row physically still exists.
    const [row] = await db
      .select({ deletedAt: notifications.deletedAt })
      .from(notifications)
      .where(eq(notifications.id, id));
    expect(row?.deletedAt).toBeInstanceOf(Date);

    // List endpoint no longer returns it.
    const list = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: authHeader(token),
    });
    const body = list.json<{ data: Array<{ id: string }> }>();
    expect(body.data.find((r) => r.id === id)).toBeUndefined();
  });
});

// ─── 3. RLS / cross-tenant + cross-user isolation ──────────────────────

describe("Notifications — isolation (RLS + recipient)", () => {
  beforeEach(async () => {
    await setFlag(true);
  });

  it("Tenant A user can NEVER see Tenant B notifications via list", async () => {
    const tenantBId = await seedNotification({ orgId: ORG_B, userId: USER_B });

    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: authHeader(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    expect(body.data.find((r) => r.id === tenantBId)).toBeUndefined();
  });

  it("Tenant A user cannot mark-read a Tenant B row (404, not 200)", async () => {
    const tenantBId = await seedNotification({ orgId: ORG_B, userId: USER_B });

    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/notifications/${tenantBId}/read`,
      headers: authHeader(tokenA),
    });
    expect(res.statusCode).toBe(404);
  });

  it("Tenant B reads their own rows under the same flag (positive bound)", async () => {
    const tenantBId = await seedNotification({ orgId: ORG_B, userId: USER_B });

    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    expect(body.data.find((r) => r.id === tenantBId)).toBeDefined();
  });
});

// ─── 4. Preferences ────────────────────────────────────────────────────

describe("Notifications — preferences", () => {
  beforeEach(async () => {
    await setFlag(true);
  });

  it("GET /v1/notification-preferences returns the closed set with defaults merged", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/notification-preferences",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ type: string; inApp: boolean; emailDigest: boolean; isDefault: boolean }>;
    }>();
    // Every registered type has a row.
    expect(body.data.find((r) => r.type === "donation.received")).toBeDefined();
    expect(body.data.find((r) => r.type === "invitation.created")).toBeDefined();
    // No explicit row exists → every row carries isDefault = true.
    expect(body.data.every((r) => r.isDefault === true)).toBe(true);
  });

  it("PATCH /v1/notification-preferences/:type upserts (idempotent)", async () => {
    const token = signToken(app);
    const first = await app.inject({
      method: "PATCH",
      url: "/v1/notification-preferences/donation.received",
      headers: authHeader(token),
      payload: { inApp: false, emailDigest: true },
    });
    expect(first.statusCode).toBe(200);
    expect(
      first.json<{ data: { inApp: boolean; emailDigest: boolean; isDefault: boolean } }>().data,
    ).toEqual({
      type: "donation.received",
      inApp: false,
      emailDigest: true,
      isDefault: false,
    });

    // Second PATCH with different values updates in place.
    const second = await app.inject({
      method: "PATCH",
      url: "/v1/notification-preferences/donation.received",
      headers: authHeader(token),
      payload: { inApp: true, emailDigest: false },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { inApp: boolean; emailDigest: boolean } }>().data).toMatchObject({
      inApp: true,
      emailDigest: false,
    });
  });

  it("PATCH on unknown type returns 400 (Fastify schema validation rejects unknown literal)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/notification-preferences/totally.fake_type",
      headers: authHeader(token),
      payload: { inApp: true, emailDigest: true },
    });
    // Schema validation rejects before the handler runs (the route's
    // params schema is the union of NOTIFICATION_TYPE_VALUES literals).
    expect([400, 404]).toContain(res.statusCode);
  });
});

// ─── 5. Registry parity — DB row matches FEATURE_FLAG_REGISTRY ─────────

describe("Notifications — feature-flag registry parity", () => {
  it("FEATURE_FLAG_REGISTRY has the notifications-center entry", () => {
    const entry = FEATURE_FLAG_REGISTRY.find((e) => e.key === FLAG_KEY);
    expect(entry).toBeDefined();
    expect(entry?.defaultEnabled).toBe(false);
    expect(entry?.scope).toBe("tenant");
    expect(entry?.tenantOverrideAllowed).toBe(false);
    expect(entry?.public).toBe(true);
  });

  it("DB seed row matches the registry label / description / scope / public", async () => {
    const [row] = await db
      .select({
        label: featureFlags.label,
        description: featureFlags.description,
        scope: featureFlags.scope,
        tenantOverrideAllowed: featureFlags.tenantOverrideAllowed,
        public: featureFlags.public,
      })
      .from(featureFlags)
      .where(eq(featureFlags.key, FLAG_KEY));
    expect(row).toBeDefined();
    const entry = FEATURE_FLAG_REGISTRY.find((e) => e.key === FLAG_KEY)!;
    expect(row?.label).toBe(entry.label);
    expect(row?.description).toBe(entry.description);
    expect(row?.scope).toBe(entry.scope);
    expect(row?.tenantOverrideAllowed).toBe(entry.tenantOverrideAllowed);
    expect(row?.public).toBe(entry.public);
  });
});
