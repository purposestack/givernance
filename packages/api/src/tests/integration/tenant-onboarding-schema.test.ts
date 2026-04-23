/**
 * Integration + unit coverage for the Tenant Onboarding schema foundation
 * landed by migration 0021 (issue #106 / ADR-016).
 *
 * - Unit: `isPersonalEmailDomain`, `isReservedSlug`, `validateTenantSlug`.
 * - DB: post-migrate back-fill, RLS isolation on `tenant_domains` +
 *   `tenant_admin_disputes`, partial-unique indexes, CHECK constraints.
 */

import { isPersonalEmailDomain, isReservedSlug } from "@givernance/shared/constants";
import { tenantAdminDisputes, tenantDomains, tenants, users } from "@givernance/shared/schema";
import { validateTenantSlug } from "@givernance/shared/validators";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { ensureTestTenants, ORG_A, ORG_B } from "../helpers/auth.js";

// A stable pair of user ids used for dispute rows. Created in this test's
// beforeAll — not part of the shared auth helpers because other suites don't
// need them.
const DISPUTE_USER_A_FIRST_ADMIN = "00000000-0000-0000-0000-00000000ca01";
const DISPUTE_USER_A_DISPUTER = "00000000-0000-0000-0000-00000000ca02";
const DISPUTE_USER_B_FIRST_ADMIN = "00000000-0000-0000-0000-00000000cb01";

beforeAll(async () => {
  await ensureTestTenants();

  // Seed two minimal users for dispute scenarios. Inserts are owner-role
  // (no RLS context) which is how the tests already seed data.
  await db.execute(sql`
    INSERT INTO users (id, org_id, email, first_name, last_name, role, first_admin)
    VALUES
      (${DISPUTE_USER_A_FIRST_ADMIN}, ${ORG_A}, 'first-a@example.org', 'First', 'AdminA', 'org_admin', true),
      (${DISPUTE_USER_A_DISPUTER},    ${ORG_A}, 'disp-a@example.org',  'Disp',  'A',      'user',      false),
      (${DISPUTE_USER_B_FIRST_ADMIN}, ${ORG_B}, 'first-b@example.org', 'First', 'AdminB', 'org_admin', true)
    ON CONFLICT (id) DO NOTHING
  `);
});

afterAll(async () => {
  // Clean up rows this suite wrote. We keep the two test tenants (shared).
  await db.execute(sql`DELETE FROM tenant_admin_disputes WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM tenant_domains WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`
    DELETE FROM users WHERE id IN (
      ${DISPUTE_USER_A_FIRST_ADMIN}, ${DISPUTE_USER_A_DISPUTER}, ${DISPUTE_USER_B_FIRST_ADMIN}
    )
  `);
});

// ─── Unit — constants ────────────────────────────────────────────────────────

describe("isPersonalEmailDomain", () => {
  it("flags common consumer domains across locales", () => {
    for (const d of [
      "gmail.com",
      "GMAIL.COM",
      "  outlook.com  ",
      "proton.me",
      "orange.fr",
      "web.de",
      "libero.it",
    ]) {
      expect(isPersonalEmailDomain(d)).toBe(true);
    }
  });

  it("does not flag actual nonprofit domains", () => {
    for (const d of ["croix-rouge.fr", "amnesty.org", "wwf.de", "unicef.ch"]) {
      expect(isPersonalEmailDomain(d)).toBe(false);
    }
  });

  it("does not flag empty or whitespace-only input as personal", () => {
    expect(isPersonalEmailDomain("")).toBe(false);
    expect(isPersonalEmailDomain("   ")).toBe(false);
  });
});

describe("isReservedSlug", () => {
  it("flags routing/platform slugs", () => {
    for (const s of ["admin", "API", "  billing  ", "select-organization", "www"]) {
      expect(isReservedSlug(s)).toBe(true);
    }
  });

  it("does not flag normal tenant slugs", () => {
    for (const s of ["croix-rouge", "amnesty-fr", "wwf", "my-ngo"]) {
      expect(isReservedSlug(s)).toBe(false);
    }
  });
});

// ─── Unit — validator ────────────────────────────────────────────────────────

describe("validateTenantSlug", () => {
  it("accepts well-formed slugs", () => {
    for (const s of ["ac", "amnesty", "amnesty-fr", "a1b2c3", "ngo-france-001"]) {
      expect(validateTenantSlug(s)).toEqual({ ok: true });
    }
  });

  it("normalises input before validating (trim + lowercase)", () => {
    // Uppercase + surrounding whitespace is fine — the validator lowercases first.
    expect(validateTenantSlug("  Amnesty  ")).toEqual({ ok: true });
    expect(validateTenantSlug("NGO-France")).toEqual({ ok: true });
  });

  it("rejects too-short, leading/trailing dash, symbols, spaces", () => {
    for (const s of ["a", "  a  ", "-ngo", "ngo-", "n go", "ngo!", "un_der"]) {
      expect(validateTenantSlug(s)).toEqual({ ok: false, reason: "syntax" });
    }
  });

  it("rejects reserved slugs with a distinct reason", () => {
    expect(validateTenantSlug("admin")).toEqual({ ok: false, reason: "reserved" });
    expect(validateTenantSlug("API")).toEqual({ ok: false, reason: "reserved" });
  });

  it("rejects slugs longer than 50 chars", () => {
    expect(validateTenantSlug("a".repeat(51))).toEqual({ ok: false, reason: "syntax" });
  });
});

// ─── DB — tenants back-fill after migration ──────────────────────────────────

describe("tenants back-fill (migration 0021)", () => {
  it("existing seeded tenants have status='active' and created_via='enterprise'", async () => {
    const rows = await db
      .select({
        id: tenants.id,
        status: tenants.status,
        createdVia: tenants.createdVia,
      })
      .from(tenants)
      .where(sql`${tenants.id} IN (${ORG_A}, ${ORG_B})`);

    // Every pre-existing tenant row inherits the new defaults from the migration.
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.createdVia).toBe("enterprise");
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("tenants.status CHECK rejects an unknown status", async () => {
    // Direct SQL: Drizzle typing would catch this at compile time, but the DB
    // must also enforce it.
    await expect(
      db.execute(sql`UPDATE tenants SET status = 'bogus' WHERE id = ${ORG_A}`),
    ).rejects.toThrow(/tenants_status_chk/);
  });

  it("tenants.created_via CHECK rejects an unknown provenance", async () => {
    await expect(
      db.execute(sql`UPDATE tenants SET created_via = 'martian' WHERE id = ${ORG_A}`),
    ).rejects.toThrow(/tenants_created_via_chk/);
  });
});

// ─── DB — tenant_domains ─────────────────────────────────────────────────────
//
// Note: the test suite connects as the `givernance` owner role (BYPASSRLS per
// ADR-016 / docs/03-data-model.md §4.1), so RLS policies do not filter reads
// here. End-to-end tenant isolation is covered by API-level tests written
// against the `givernance_app` role. These tests focus on structural correctness
// (inserts succeed, constraints fire, partial indexes behave).

describe("tenant_domains", () => {
  it("accepts inserts under each tenant context", async () => {
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ORG_A,
        domain: "ngo-a-rls.test",
        dnsTxtValue: "givernance-verify=aaa",
      });
    });
    await withTenantContext(ORG_B, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ORG_B,
        domain: "ngo-b-rls.test",
        dnsTxtValue: "givernance-verify=bbb",
      });
    });

    const rows = await db
      .select({ orgId: tenantDomains.orgId, domain: tenantDomains.domain })
      .from(tenantDomains)
      .where(sql`${tenantDomains.domain} IN ('ngo-a-rls.test', 'ngo-b-rls.test')`);

    expect(rows.some((r) => r.domain === "ngo-a-rls.test" && r.orgId === ORG_A)).toBe(true);
    expect(rows.some((r) => r.domain === "ngo-b-rls.test" && r.orgId === ORG_B)).toBe(true);
  });

  it("partial unique index rejects a second active claim of the same domain", async () => {
    const dup = `dup-${Date.now()}.test`;
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ORG_A,
        domain: dup,
        dnsTxtValue: "givernance-verify=ddd",
      });
    });

    await expect(
      withTenantContext(ORG_B, async (tx) => {
        await tx.insert(tenantDomains).values({
          orgId: ORG_B,
          domain: dup,
          dnsTxtValue: "givernance-verify=eee",
        });
      }),
    ).rejects.toThrow(/tenant_domains_active_domain_uniq/);
  });

  it("revoked rows free the domain slot", async () => {
    const d = `revoked-${Date.now()}.test`;
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ORG_A,
        domain: d,
        dnsTxtValue: "givernance-verify=111",
        state: "revoked",
      });
    });

    // Another tenant can now claim it because only non-revoked rows enter the
    // partial unique index.
    await expect(
      withTenantContext(ORG_B, async (tx) => {
        await tx.insert(tenantDomains).values({
          orgId: ORG_B,
          domain: d,
          dnsTxtValue: "givernance-verify=222",
        });
      }),
    ).resolves.not.toThrow();
  });

  it("CHECK forces lowercase domains", async () => {
    await expect(
      withTenantContext(ORG_A, async (tx) => {
        await tx.insert(tenantDomains).values({
          orgId: ORG_A,
          domain: "UPPER.test",
          dnsTxtValue: "givernance-verify=xxx",
        });
      }),
    ).rejects.toThrow(/tenant_domains_lowercase_chk/);
  });
});

// ─── DB — tenant_admin_disputes ──────────────────────────────────────────────

describe("tenant_admin_disputes", () => {
  it("accepts an open dispute under the tenant context", async () => {
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(tenantAdminDisputes).values({
        orgId: ORG_A,
        disputerId: DISPUTE_USER_A_DISPUTER,
        provisionalAdminId: DISPUTE_USER_A_FIRST_ADMIN,
        reason: "Not actually the director",
      });
    });

    const rows = await db
      .select({ orgId: tenantAdminDisputes.orgId, resolution: tenantAdminDisputes.resolution })
      .from(tenantAdminDisputes)
      .where(eq(tenantAdminDisputes.orgId, ORG_A));
    expect(rows.some((r) => r.orgId === ORG_A && r.resolution === null)).toBe(true);
  });

  it("one-open-per-tenant partial unique index rejects a second open dispute", async () => {
    await expect(
      withTenantContext(ORG_A, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ORG_A,
          disputerId: DISPUTE_USER_A_DISPUTER,
          provisionalAdminId: DISPUTE_USER_A_FIRST_ADMIN,
          reason: "Second open dispute should fail",
        });
      }),
    ).rejects.toThrow(/tenant_admin_disputes_one_open_per_tenant/);
  });

  it("allows a new dispute after the previous one is resolved", async () => {
    // Resolve the open one first.
    await withTenantContext(ORG_A, async (tx) => {
      await tx
        .update(tenantAdminDisputes)
        .set({ resolution: "kept", resolvedAt: new Date() })
        .where(and(eq(tenantAdminDisputes.orgId, ORG_A), sql`resolution IS NULL`));
    });

    await expect(
      withTenantContext(ORG_A, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ORG_A,
          disputerId: DISPUTE_USER_A_DISPUTER,
          provisionalAdminId: DISPUTE_USER_A_FIRST_ADMIN,
          reason: "New dispute after closure",
        });
      }),
    ).resolves.not.toThrow();
  });

  it("rejects a dispute where disputer equals provisional admin", async () => {
    await expect(
      withTenantContext(ORG_B, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ORG_B,
          disputerId: DISPUTE_USER_B_FIRST_ADMIN,
          provisionalAdminId: DISPUTE_USER_B_FIRST_ADMIN,
          reason: "Self-dispute",
        });
      }),
    ).rejects.toThrow(/tenant_admin_disputes_different_actors_chk/);
  });

  it("CHECK rejects unknown resolution values", async () => {
    await expect(
      db.execute(
        sql`UPDATE tenant_admin_disputes SET resolution = 'bogus' WHERE org_id = ${ORG_A}`,
      ),
    ).rejects.toThrow(/tenant_admin_disputes_resolution_chk/);
  });
});

// ─── DB — users.first_admin + provisional_until ──────────────────────────────

describe("users provisional-admin fields", () => {
  it("CHECK prevents provisional_until without first_admin", async () => {
    await expect(
      db.execute(sql`
        UPDATE users
        SET first_admin = false, provisional_until = now() + interval '7 days'
        WHERE id = ${DISPUTE_USER_A_DISPUTER}
      `),
    ).rejects.toThrow(/users_provisional_requires_first_admin_chk/);
  });

  it("allows provisional_until when first_admin is true", async () => {
    await expect(
      db.execute(sql`
        UPDATE users
        SET provisional_until = now() + interval '7 days'
        WHERE id = ${DISPUTE_USER_A_FIRST_ADMIN}
      `),
    ).resolves.not.toThrow();

    const [row] = await db
      .select({ first: users.firstAdmin, until: users.provisionalUntil })
      .from(users)
      .where(eq(users.id, DISPUTE_USER_A_FIRST_ADMIN));
    expect(row?.first).toBe(true);
    expect(row?.until).toBeTruthy();
  });
});
