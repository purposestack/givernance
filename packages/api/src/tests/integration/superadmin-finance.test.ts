/**
 * Issue #437 — super-admin finance dashboard + survey endpoints.
 *
 * Coverage:
 *   - RBAC matrix per route: super_admin → 200/202; org_admin / user /
 *     viewer → 404 (anti-disclosure); unauthenticated → 401.
 *   - Flag off → 404 on every gated route.
 *   - Custom-range fuzz: missing bounds, `from > to`, oversize window,
 *     `1900-01-01` clamping, `'; DROP TABLE` SQLi attempt.
 *   - Idempotent launch: replay with same key → cached 202.
 *   - 24h cooldown: 2nd launch under cooldown → 429 + `Retry-After`.
 *   - Cross-user invitation submission → 404 (not 403).
 *   - One-response-per-invitation enforced (409).
 *   - Free-text XSS payload (`<script>`) → 400.
 *   - RFC-9457 body shape locked on representative error paths.
 *   - Regression guard: org_admin GET /v1/donations/:id MUST NOT
 *     include `stripeFeeCents` (epic #434 security-architect BLOCKING).
 */

import { randomUUID } from "node:crypto";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { featureFlags } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, systemDb } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  USER_A,
  USER_A_ROW_ID,
  USER_B_ROW_ID,
} from "../helpers/auth.js";

const FLAG_KEY = FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD;
const SUPER_ADMIN_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000437ad";
const SUPER_ADMIN_PLATFORM_ROW_ID = "00000000-0000-0000-0000-0000000437a1";
const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-0000000000a1";

const PMF_SLUG = "pmf-sean-ellis";
const NPS_SLUG = "nps-quarterly";
const CSAT_SLUG = "csat-post-ticket";

let app: FastifyInstance;
let pmfSurveyId: string;
let pmfInvitationForUserA: string;
let pmfInvitationForUserB: string;

function superAdminToken() {
  return signToken(app, {
    sub: SUPER_ADMIN_KEYCLOAK_ID,
    realm_access: { roles: ["super_admin"] },
    role: undefined,
    email: "super-finance@example.org",
  });
}

async function setFlag(enabled: boolean): Promise<void> {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
}

async function clearRedisCache(): Promise<void> {
  // The summary cache is keyed under a fixed prefix; KEYS is fine here
  // because the test Redis is local.
  const keys = await redis.keys("superadmin:finance:summary:v1:*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

async function seedSurveys(): Promise<void> {
  // The surveys.slug uniqueness is enforced by a PARTIAL unique index
  // (`WHERE deleted_at IS NULL`) — Postgres ON CONFLICT can't infer
  // a partial index without specifying the predicate, so we do a
  // delete-then-insert to stay idempotent across test runs.
  await systemDb.execute(
    sql`DELETE FROM surveys WHERE slug IN (${PMF_SLUG}, ${NPS_SLUG}, ${CSAT_SLUG})`,
  );
  await systemDb.execute(sql`
    INSERT INTO surveys (id, kind, slug, question_fr, question_en, freshness_soon_days, freshness_stale_days, cadence_days)
    VALUES
      (gen_random_uuid(), 'pmf',  ${PMF_SLUG},  'PMF FR', 'PMF EN', 90, 180, 90),
      (gen_random_uuid(), 'nps',  ${NPS_SLUG},  'NPS FR', 'NPS EN', 90, 180, 90),
      (gen_random_uuid(), 'csat', ${CSAT_SLUG}, 'CSAT FR','CSAT EN', 30, 90,  NULL)
  `);

  const [pmf] = (
    await systemDb.execute<{ id: string }>(
      sql`SELECT id FROM surveys WHERE slug = ${PMF_SLUG} LIMIT 1`,
    )
  ).rows;
  pmfSurveyId = pmf?.id ?? "";

  // Seed one PMF invitation per test user, in the future so they're active.
  pmfInvitationForUserA = randomUUID();
  pmfInvitationForUserB = randomUUID();
  await systemDb.execute(sql`
    INSERT INTO survey_invitations (id, survey_id, user_id, org_id, channel, expires_at)
    VALUES
      (${pmfInvitationForUserA}, ${pmfSurveyId}, ${USER_A_ROW_ID}, ${ORG_A}, 'in_app', NOW() + INTERVAL '14 days'),
      (${pmfInvitationForUserB}, ${pmfSurveyId}, ${USER_B_ROW_ID}, ${ORG_B}, 'in_app', NOW() + INTERVAL '14 days')
    ON CONFLICT (id) DO NOTHING
  `);
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Sentinel platform tenant — required as FK target for audit_logs.
  await systemDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${PLATFORM_TENANT_ID}, 'Givernance Platform (sentinel)', '__platform__', 'archived')
    ON CONFLICT (id) DO NOTHING
  `);

  // Seed a super-admin platform_admins row so the launch handler can
  // resolve `launched_by` (a FK on platform_admins.id).
  await systemDb.execute(sql`
    INSERT INTO platform_admins (id, keycloak_id, email, first_name, last_name)
    VALUES (${SUPER_ADMIN_PLATFORM_ROW_ID}, ${SUPER_ADMIN_KEYCLOAK_ID}, 'super-finance@example.org', 'Finance', 'Super')
    ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, keycloak_id = ${SUPER_ADMIN_KEYCLOAK_ID}
  `);

  await seedSurveys();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await clearRedisCache();
  // Default ON for most tests — flag-off coverage explicitly toggles back.
  await setFlag(true);
  // Clean state per test.
  await systemDb.execute(sql`DELETE FROM survey_launches WHERE survey_id = ${pmfSurveyId}`);
  await systemDb.execute(
    sql`DELETE FROM survey_responses WHERE invitation_id IN (${pmfInvitationForUserA}, ${pmfInvitationForUserB})`,
  );
});

afterEach(async () => {
  await setFlag(false);
});

// ─── GET /v1/superadmin/finance/summary ─────────────────────────────────

describe("GET /v1/superadmin/finance/summary", () => {
  describe("RBAC matrix", () => {
    it("super_admin → 200 with locked shape", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=30d",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: {
          period: { from: string; to: string; label: string };
          kpis: { volumeCents: number; deltas: object };
          surveys: unknown[];
        };
      };
      expect(body.data.period.label).toBe("30 derniers jours");
      expect(typeof body.data.kpis.volumeCents).toBe("number");
      expect(Array.isArray(body.data.surveys)).toBe(true);
    });

    it("org_admin → 404 (anti-disclosure)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=30d",
        headers: authHeader(signToken(app)),
      });
      expect(res.statusCode).toBe(404);
    });

    it("user role → 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=30d",
        headers: authHeader(signToken(app, { role: "user" })),
      });
      expect(res.statusCode).toBe(404);
    });

    it("viewer role → 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=30d",
        headers: authHeader(signToken(app, { role: "viewer" })),
      });
      expect(res.statusCode).toBe(404);
    });

    it("unauthenticated → 401 with RFC-9457 body", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=30d",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        type: "https://httpproblems.com/http-status/401",
        title: "Unauthorized",
        status: 401,
      });
    });

    it("flag off → 404 (gated route invisible)", async () => {
      await setFlag(false);
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=30d",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        type: "https://httpproblems.com/http-status/404",
        title: "Not Found",
        status: 404,
      });
    });
  });

  describe("custom-range fuzz", () => {
    it("missing from/to on custom → 400 RFC-9457", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=custom",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        type: "https://httpproblems.com/http-status/400",
        title: "Bad Request",
        status: 400,
      });
    });

    it("from > to → 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=custom&from=2025-06-01&to=2025-01-01",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(400);
    });

    it("(to - from) > 366d → 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=custom&from=2024-01-01&to=2025-12-31",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { detail: string }).detail).toMatch(/max allowed/i);
    });

    it("from < 2024-01-01 → clamped + 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary?period=custom&from=1900-01-01&to=2024-06-01",
        headers: authHeader(superAdminToken()),
      });
      // 1900-01-01 → 2024-06-01 spans > 366d, would normally 400. But
      // we clamp from to 2024-01-01 first, then check the span: 2024-01-01
      // → 2024-06-01 is < 366d so this passes.
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { period: { from: string } } };
      expect(body.data.period.from.startsWith("2024-01-01")).toBe(true);
    });

    it("from with SQL injection payload → 400 (TypeBox rejects before SQL)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/superadmin/finance/summary?period=custom&from=${encodeURIComponent(
          "'; DROP TABLE donations; --",
        )}&to=2025-01-01`,
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it("regression guard: org_admin GET /v1/donations/:id does NOT expose stripeFeeCents", async () => {
    // Seed a donation, then read it back as org_admin.
    const cstRes = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(signToken(app)),
      payload: { firstName: "Strict", lastName: "Donor", type: "donor" },
    });
    const constituentId = cstRes.json<{ data: { id: string } }>().data.id;

    const donRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(signToken(app)),
      payload: { constituentId, amountCents: 5000, currency: "EUR" },
    });
    expect(donRes.statusCode).toBe(201);
    const donationId = donRes.json<{ data: { id: string } }>().data.id;

    const detailRes = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(signToken(app)),
    });
    expect(detailRes.statusCode).toBe(200);
    const detailBody = detailRes.json() as { data: Record<string, unknown> };
    expect(detailBody.data).not.toHaveProperty("stripeFeeCents");
    expect(detailBody.data).not.toHaveProperty("stripe_fee_cents");
  });
});

// ─── Archived-tenant exclusion from aggregates ──────────────────────────

describe("GET /v1/superadmin/finance/summary — archived/suspended tenants", () => {
  const ARCHIVED_ORG = "00000000-0000-0000-0000-0000000004ad";
  const ARCHIVED_CONSTITUENT = "00000000-0000-0000-0000-0000000004cd";
  const ARCHIVED_DONATION = "00000000-0000-0000-0000-0000000004d1";

  beforeAll(async () => {
    // Seed an ARCHIVED tenant with one cleared donation in the last 7 days.
    // The aggregations MUST exclude it from every KPI, perTenant row, and
    // perCurrency bucket (payment-engineer BLOCKING in Epic #434).
    await systemDb.execute(sql`
      INSERT INTO tenants (id, name, slug, status)
      VALUES (${ARCHIVED_ORG}, 'Archived Org', 'test-archived-org', 'archived')
      ON CONFLICT (id) DO UPDATE SET status = 'archived'
    `);
    await systemDb.execute(sql`
      INSERT INTO constituents (id, org_id, first_name, last_name, type)
      VALUES (${ARCHIVED_CONSTITUENT}, ${ARCHIVED_ORG}, 'Archived', 'Donor', 'donor')
      ON CONFLICT (id) DO NOTHING
    `);
    await systemDb.execute(sql`
      INSERT INTO donations (
        id, org_id, constituent_id, amount_cents, currency,
        exchange_rate, amount_base_cents, platform_fee_base_cents,
        status, donated_at
      )
      VALUES (
        ${ARCHIVED_DONATION}, ${ARCHIVED_ORG}, ${ARCHIVED_CONSTITUENT},
        99999900, 'EUR', 1.00000000, 99999900, 999999,
        'cleared', NOW() - INTERVAL '2 days'
      )
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    await systemDb.execute(sql`DELETE FROM donations WHERE id = ${ARCHIVED_DONATION}`);
    await systemDb.execute(sql`DELETE FROM constituents WHERE id = ${ARCHIVED_CONSTITUENT}`);
    await systemDb.execute(sql`DELETE FROM tenants WHERE id = ${ARCHIVED_ORG}`);
  });

  it("archived tenant's donations excluded from every KPI + perTenant + perCurrency", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/summary?period=7d",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        kpis: { volumeCents: number };
        perTenant: Array<{ tenantId: string; tenantName: string; volumeCents: number }>;
        perCurrency: Array<{ currency: string; volumeCents: number }>;
      };
    };

    // The archived tenant's EUR 999,999.00 donation must NOT appear anywhere.
    const archivedRow = body.data.perTenant.find((r) => r.tenantId === ARCHIVED_ORG);
    expect(archivedRow).toBeUndefined();

    // No perTenant row should ever expose the archived tenant's name either.
    expect(body.data.perTenant.every((r) => r.tenantName !== "Archived Org")).toBe(true);

    // The platform KPI volume should be way under 99,999,900 cents — the
    // archived donation alone is ~€1M and would dominate any honest test
    // window. If the filter ever regresses this assertion will go red.
    expect(body.data.kpis.volumeCents).toBeLessThan(99_999_900);

    // perCurrency EUR bucket (if present) must not be inflated by the
    // archived donation alone.
    const eur = body.data.perCurrency.find((c) => c.currency === "EUR");
    if (eur) {
      expect(eur.volumeCents).toBeLessThan(99_999_900);
    }
  });
});

// ─── GET /v1/superadmin/finance/summary.csv (#442) ──────────────────────

describe("GET /v1/superadmin/finance/summary.csv", () => {
  describe("RBAC matrix", () => {
    it("super_admin → 200 with text/csv body + attachment disposition", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary.csv?period=30d",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(
        /^attachment; filename="givernance-finance-30d-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("org_admin → 404 (anti-disclosure)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary.csv?period=30d",
        headers: authHeader(signToken(app)),
      });
      expect(res.statusCode).toBe(404);
    });

    it("user role → 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary.csv?period=30d",
        headers: authHeader(signToken(app, { role: "user" })),
      });
      expect(res.statusCode).toBe(404);
    });

    it("viewer role → 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary.csv?period=30d",
        headers: authHeader(signToken(app, { role: "viewer" })),
      });
      expect(res.statusCode).toBe(404);
    });

    it("unauthenticated → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary.csv?period=30d",
      });
      expect(res.statusCode).toBe(401);
    });

    it("flag off → 404", async () => {
      await setFlag(false);
      const res = await app.inject({
        method: "GET",
        url: "/v1/superadmin/finance/summary.csv?period=30d",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it("body shape — four sections in order with correct headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/summary.csv?period=30d",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // UTF-8 BOM at start so Excel auto-detects encoding.
    expect(body.charCodeAt(0)).toBe(0xfeff);
    // Section headers in order
    const kpisIdx = body.indexOf("# KPIs");
    const perTenantIdx = body.indexOf("# Per-tenant");
    const perCurrencyIdx = body.indexOf("# Per-currency");
    const timeseriesIdx = body.indexOf("# Timeseries");
    expect(kpisIdx).toBeGreaterThanOrEqual(0);
    expect(perTenantIdx).toBeGreaterThan(kpisIdx);
    expect(perCurrencyIdx).toBeGreaterThan(perTenantIdx);
    expect(timeseriesIdx).toBeGreaterThan(perCurrencyIdx);
    // Column headers per spec
    expect(body).toContain("metric,value,unit,delta_percent");
    expect(body).toContain("tenant_id,tenant_name,grade,score,volume_eur,donation_count,share_pct");
    expect(body).toContain("currency,volume_eur,donation_count");
    expect(body).toContain("date,volume_eur,revenue_eur");
    // CRLF line endings (RFC 4180)
    expect(body).toContain("\r\n");
  });

  it("400 RFC-9457 on invalid custom range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/summary.csv?period=custom&from=2025-06-01&to=2025-01-01",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: expect.any(String),
      title: expect.any(String),
      status: 400,
    });
  });

  it("emits audit log with action='export'", async () => {
    const before = await systemDb.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'export' AND resource_type = 'platform_finance_summary'`,
    );
    const beforeCount = Number(before.rows[0]?.count ?? "0");

    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/summary.csv?period=7d&currency=EUR",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(200);

    const after = await systemDb.execute<{ count: string; new_values: unknown }>(
      sql`SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'export' AND resource_type = 'platform_finance_summary'`,
    );
    const afterCount = Number(after.rows[0]?.count ?? "0");
    expect(afterCount).toBe(beforeCount + 1);
  });
});

// ─── POST /v1/superadmin/surveys/:slug/launch ───────────────────────────

describe("POST /v1/superadmin/surveys/:slug/launch", () => {
  it("super_admin + valid Idempotency-Key → 202", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      data: { launchId: string; surveyId: string; channel: string; recipientCount: number };
    };
    expect(body.data.channel).toBe("email");
    expect(body.data.surveyId).toBe(pmfSurveyId);
  });

  it("missing Idempotency-Key → 400 RFC-9457", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: authHeader(superAdminToken()),
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/400",
      title: "Bad Request",
      status: 400,
    });
  });

  it("malformed Idempotency-Key → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": "not-a-uuid" },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("replay with same Idempotency-Key → cached 202 (same launchId)", async () => {
    const key = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": key },
      payload: { channel: "email" },
    });
    expect(first.statusCode).toBe(202);
    const firstId = first.json<{ data: { launchId: string } }>().data.launchId;

    const second = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": key },
      payload: { channel: "email" },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json<{ data: { launchId: string } }>().data.launchId).toBe(firstId);

    // Only one row in survey_launches for this key.
    const rows = await systemDb.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM survey_launches WHERE idempotency_key = ${key}`,
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("2nd launch within 24h with NEW key → 429 + Retry-After", async () => {
    // First launch lands.
    const first = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(first.statusCode).toBe(202);

    // Second launch (fresh key) hits the cooldown.
    const second = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    expect(second.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/429",
      title: "Too Many Requests",
      status: 429,
    });
  });

  it("unknown slug → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/superadmin/surveys/nonexistent-survey/launch",
      headers: { ...authHeader(superAdminToken()), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("malformed slug (path-traversal) → 400 schema rejection", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/superadmin/surveys/..%2Fadmin/launch",
      headers: { ...authHeader(superAdminToken()), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("org_admin → 404 (anti-disclosure)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(signToken(app)), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("flag off → 404", async () => {
    await setFlag(false);
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": randomUUID() },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-v4 UUID Idempotency-Key → 400 (v3/v5 must fail closed)", async () => {
    // RFC-4122 v3 (MD5-namespaced): the third group starts with '3', not '4'.
    const v3Key = "12345678-1234-3456-8123-1234567890ab";
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": v3Key },
      payload: { channel: "email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("replay with same Idempotency-Key but different channel → 409 RFC-9457", async () => {
    const key = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": key },
      payload: { channel: "email" },
    });
    expect(first.statusCode).toBe(202);

    // Same key, different channel — must fail with 409.
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": key },
      payload: { channel: "in_app" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      type: "https://givernance.io/problems/idempotency-key-conflict",
      title: "Idempotency-Key reused with different request body",
      status: 409,
    });
  });

  it("replay with same Idempotency-Key but different slug → 409", async () => {
    const key = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": key },
      payload: { channel: "email" },
    });
    expect(first.statusCode).toBe(202);

    const conflict = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${NPS_SLUG}/launch`,
      headers: { ...authHeader(superAdminToken()), "idempotency-key": key },
      payload: { channel: "email" },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { type: string }).type).toBe(
      "https://givernance.io/problems/idempotency-key-conflict",
    );
  });
});

// ─── POST /v1/superadmin/surveys/:slug/schedule ─────────────────────────

describe("POST /v1/superadmin/surveys/:slug/schedule", () => {
  it("super_admin → 200; updates cadence_days", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${CSAT_SLUG}/schedule`,
      headers: authHeader(superAdminToken()),
      payload: { cadence: "monthly" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { cadence: string; cadenceDays: number | null };
    };
    expect(body.data.cadence).toBe("monthly");
    expect(body.data.cadenceDays).toBe(30);
  });

  it("re-applying current cadence → 200 no-op", async () => {
    // First call sets monthly.
    await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${CSAT_SLUG}/schedule`,
      headers: authHeader(superAdminToken()),
      payload: { cadence: "monthly" },
    });
    const replay = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${CSAT_SLUG}/schedule`,
      headers: authHeader(superAdminToken()),
      payload: { cadence: "monthly" },
    });
    expect(replay.statusCode).toBe(200);
  });

  it("org_admin → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/surveys/${PMF_SLUG}/schedule`,
      headers: authHeader(signToken(app)),
      payload: { cadence: "monthly" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /v1/surveys/:invitationId/respond ─────────────────────────────

describe("POST /v1/surveys/:invitationId/respond", () => {
  it("happy path → 200; one row in survey_responses", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      headers: authHeader(signToken(app, { sub: USER_A })),
      payload: { response: { category: "very_disappointed", why_text: "I love it" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { responseId: string; submittedAt: string } };
    expect(body.data.responseId).toMatch(/^[0-9a-f-]{36}$/);
    // Never echo response back.
    expect(body.data).not.toHaveProperty("response");

    const rows = await systemDb.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM survey_responses WHERE invitation_id = ${pmfInvitationForUserA}`,
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("cross-user submission (User B trying to answer User A's invite) → 404 (not 403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      headers: authHeader(
        signToken(app, {
          sub: "00000000-0000-0000-0000-000000000098", // USER_B sub
          org_id: ORG_B,
          email: "user-b@example.org",
        }),
      ),
      payload: { response: { category: "very_disappointed" } },
    });
    expect(res.statusCode).toBe(404);
    // RFC-9457 body shape locked.
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/404",
      title: "Not Found",
      status: 404,
    });
  });

  it("unknown invitation id → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/surveys/${randomUUID()}/respond`,
      headers: authHeader(signToken(app, { sub: USER_A })),
      payload: { response: { category: "not_disappointed" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("free-text containing `<` → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      headers: authHeader(signToken(app, { sub: USER_A })),
      payload: {
        response: {
          category: "very_disappointed",
          why_text: "<script>alert(1)</script>",
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/400",
      title: "Bad Request",
      status: 400,
    });
  });

  it("double-submission → 409", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      headers: authHeader(signToken(app, { sub: USER_A })),
      payload: { response: { category: "very_disappointed" } },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      headers: authHeader(signToken(app, { sub: USER_A })),
      payload: { response: { category: "very_disappointed" } },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/409",
      title: "Conflict",
      status: 409,
    });
  });

  it("unauthenticated → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      payload: { response: { category: "very_disappointed" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("flag off → 404", async () => {
    await setFlag(false);
    const res = await app.inject({
      method: "POST",
      url: `/v1/surveys/${pmfInvitationForUserA}/respond`,
      headers: authHeader(signToken(app, { sub: USER_A })),
      payload: { response: { category: "very_disappointed" } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/superadmin/finance/cache/flush (#449)", () => {
  const CACHE_KEY_A = "superadmin:finance:summary:v1:30d:_:_:all:all";
  const CACHE_KEY_B = "superadmin:finance:summary:v1:90d:_:_:EUR:all";
  // Decoy key with a different prefix — must NOT be touched by the flush.
  const DECOY_KEY = "notifications:test:fixture-449";

  beforeEach(async () => {
    // Clear @fastify/rate-limit state — keys live under
    // `fastify-rate-limit-*` (see filters.test.ts pattern). Without
    // this, the 5/min cap on /cache/flush bleeds across test cases
    // and a single 429 cascades the whole suite.
    const rlKeys = await redis.keys("fastify-rate-limit-*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);
    await redis.set(CACHE_KEY_A, JSON.stringify({ data: "seeded-30d" }), "EX", 300);
    await redis.set(CACHE_KEY_B, JSON.stringify({ data: "seeded-90d" }), "EX", 300);
    await redis.set(DECOY_KEY, "untouched", "EX", 300);
  });
  afterEach(async () => {
    await redis.del(CACHE_KEY_A, CACHE_KEY_B, DECOY_KEY);
  });

  describe("RBAC matrix", () => {
    it("super_admin → 200 + keysDeleted reflects the flushed count", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/cache/flush",
        headers: authHeader(superAdminToken()),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: { keysDeleted: number; pattern: string };
      };
      expect(body.data.pattern).toBe("superadmin:finance:summary:v1:*");
      expect(body.data.keysDeleted).toBeGreaterThanOrEqual(2);
      // Seeded cache keys are gone.
      expect(await redis.exists(CACHE_KEY_A)).toBe(0);
      expect(await redis.exists(CACHE_KEY_B)).toBe(0);
      // Decoy key with different prefix is INTACT — pattern-scope is strict.
      expect(await redis.exists(DECOY_KEY)).toBe(1);
    });

    it("org_admin → 404 (anti-disclosure)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/cache/flush",
        headers: authHeader(signToken(app)),
      });
      expect(res.statusCode).toBe(404);
      // Cache keys still present — RBAC blocked the operation.
      expect(await redis.exists(CACHE_KEY_A)).toBe(1);
    });

    it("user role → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/cache/flush",
        headers: authHeader(signToken(app, { role: "user" })),
      });
      expect(res.statusCode).toBe(404);
    });

    it("viewer role → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/cache/flush",
        headers: authHeader(signToken(app, { role: "viewer" })),
      });
      expect(res.statusCode).toBe(404);
    });

    it("unauthenticated → 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/cache/flush",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it("flag off → 404", async () => {
    await setFlag(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/cache/flush",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(404);
  });

  it("idempotent: flushing twice keeps decoy keys intact and returns 0 the second time", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/cache/flush",
      headers: authHeader(superAdminToken()),
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/cache/flush",
      headers: authHeader(superAdminToken()),
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as { data: { keysDeleted: number } };
    expect(body.data.keysDeleted).toBe(0);
    expect(await redis.exists(DECOY_KEY)).toBe(1);
  });

  it("does NOT accept a client-supplied pattern (no body / query / header)", async () => {
    // Even when sending a payload + query trying to extend the scan
    // scope, the server must ignore it and only flush
    // `superadmin:finance:summary:v1:*`.
    const res = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/cache/flush?pattern=*",
      headers: authHeader(superAdminToken()),
      payload: { pattern: "*" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { pattern: string } };
    expect(body.data.pattern).toBe("superadmin:finance:summary:v1:*");
    // Decoy with `notifications:*` prefix MUST still be intact —
    // proof the client-supplied `*` was ignored.
    expect(await redis.exists(DECOY_KEY)).toBe(1);
  });
});
