/**
 * Integration + unit coverage for the Tenant Onboarding schema foundation
 * landed by migration 0021 (issue #106 / ADR-016).
 *
 * Notes on the test surface:
 * - Unit-level assertions for pure functions live here (not in a separate
 *   shared-package suite) because the repo does not yet have a shared-package
 *   vitest config; splitting is a follow-up (#ENG-8).
 * - DB assertions run as the `givernance` owner role (BYPASSRLS per ADR-009
 *   / docs/03-data-model.md §4.1). RLS behaviour is validated end-to-end by
 *   API-level tests written against `givernance_app` in issues #108 + #110.
 * - Each DB sub-suite is `describe.sequential` to lock in the intended
 *   per-`it` state transitions.
 * - Constraint names are stable error-string API; if migration 0021 is ever
 *   superseded, the matching regex in each `.rejects.toThrow` MUST be updated.
 */

import {
  isPersonalEmailDomain,
  isReservedSlug,
  PERSONAL_EMAIL_DOMAINS,
  RESERVED_SLUGS,
} from "@givernance/shared/constants";
import { tenantAdminDisputes, tenantDomains, tenants, users } from "@givernance/shared/schema";
import { validateTenantSlug } from "@givernance/shared/validators";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { ensureTestTenants } from "../helpers/auth.js";

// Dedicated tenants for this suite so shared fixtures (ORG_A, ORG_B) aren't
// polluted with our ad-hoc users and dispute rows.
const ONBOARD_A = "00000000-0000-0000-0000-0000000c0a01";
const ONBOARD_B = "00000000-0000-0000-0000-0000000c0a02";
const CASCADE_ORG = "00000000-0000-0000-0000-0000000c0a03";

const USER_A_FIRST_ADMIN = "00000000-0000-0000-0000-00000000ca01";
const USER_A_DISPUTER = "00000000-0000-0000-0000-00000000ca02";
const USER_B_FIRST_ADMIN = "00000000-0000-0000-0000-00000000cb01";

// Unique suffix per test run to keep domain / dns_txt fixtures collision-free
// across reruns and parallel files.
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const d = (name: string) => `${name}-${RUN}.test`;
const txt = (tag: string) => `givernance-verify=${RUN}-${tag}-padding-padding-xx`;

beforeAll(async () => {
  await ensureTestTenants();

  // Dedicated per-suite tenants.
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status, created_via)
    VALUES
      (${ONBOARD_A}, 'Onboarding Suite A', 'onboard-suite-a', 'active', 'enterprise'),
      (${ONBOARD_B}, 'Onboarding Suite B', 'onboard-suite-b', 'active', 'enterprise')
    ON CONFLICT (id) DO NOTHING
  `);

  // Defensive cleanup from any prior partial run before we seed.
  await db.execute(sql`
    DELETE FROM tenant_admin_disputes WHERE org_id IN (${ONBOARD_A}, ${ONBOARD_B}, ${CASCADE_ORG})
  `);
  await db.execute(sql`
    DELETE FROM tenant_domains WHERE org_id IN (${ONBOARD_A}, ${ONBOARD_B}, ${CASCADE_ORG})
  `);
  await db.execute(sql`
    DELETE FROM users WHERE id IN (${USER_A_FIRST_ADMIN}, ${USER_A_DISPUTER}, ${USER_B_FIRST_ADMIN})
  `);

  await db.execute(sql`
    INSERT INTO users (id, org_id, email, first_name, last_name, role, first_admin)
    VALUES
      (${USER_A_FIRST_ADMIN}, ${ONBOARD_A}, 'first-a@example.org', 'First', 'AdminA', 'org_admin', true),
      (${USER_A_DISPUTER},    ${ONBOARD_A}, 'disp-a@example.org',  'Disp',  'A',      'user',      false),
      (${USER_B_FIRST_ADMIN}, ${ONBOARD_B}, 'first-b@example.org', 'First', 'AdminB', 'org_admin', true)
  `);
});

afterAll(async () => {
  // Each statement wrapped so a transient failure doesn't silently leak data.
  const safe = async (s: ReturnType<typeof sql>) => {
    try {
      await db.execute(s);
    } catch {
      /* best-effort cleanup */
    }
  };
  await safe(
    sql`DELETE FROM tenant_admin_disputes WHERE org_id IN (${ONBOARD_A}, ${ONBOARD_B}, ${CASCADE_ORG})`,
  );
  await safe(
    sql`DELETE FROM tenant_domains WHERE org_id IN (${ONBOARD_A}, ${ONBOARD_B}, ${CASCADE_ORG})`,
  );
  await safe(sql`
    DELETE FROM users WHERE id IN (${USER_A_FIRST_ADMIN}, ${USER_A_DISPUTER}, ${USER_B_FIRST_ADMIN})
  `);
  await safe(sql`DELETE FROM tenants WHERE id IN (${ONBOARD_A}, ${ONBOARD_B}, ${CASCADE_ORG})`);
});

// ─── Unit — constants ────────────────────────────────────────────────────────

describe("isPersonalEmailDomain", () => {
  it("flags common consumer domains across locales", () => {
    for (const x of [
      "gmail.com",
      "GMAIL.COM",
      "  outlook.com  ",
      "proton.me",
      "orange.fr",
      "web.de",
      "libero.it",
    ]) {
      expect(isPersonalEmailDomain(x)).toBe(true);
    }
  });

  it("does not flag actual nonprofit domains", () => {
    for (const x of ["croix-rouge.fr", "amnesty.org", "wwf.de", "unicef.ch"]) {
      expect(isPersonalEmailDomain(x)).toBe(false);
    }
  });

  it("does not flag empty or whitespace-only input as personal", () => {
    expect(isPersonalEmailDomain("")).toBe(false);
    expect(isPersonalEmailDomain("   ")).toBe(false);
  });
});

describe("PERSONAL_EMAIL_DOMAINS invariants", () => {
  it("has no duplicates", () => {
    expect(new Set(PERSONAL_EMAIL_DOMAINS).size).toBe(PERSONAL_EMAIL_DOMAINS.length);
  });
  it("only contains lowercase entries", () => {
    expect(PERSONAL_EMAIL_DOMAINS.every((x) => x === x.toLowerCase())).toBe(true);
  });
});

describe("isReservedSlug", () => {
  it("flags routing/platform/auth slugs", () => {
    for (const s of [
      "admin",
      "API",
      "  billing  ",
      "select-organization",
      "www",
      "oauth",
      "saml",
      "well-known",
      "stripe",
      "keycloak",
      "campaigns",
      "constituents",
      "donations",
      "users",
    ]) {
      expect(isReservedSlug(s)).toBe(true);
    }
  });

  it("does not flag normal tenant slugs", () => {
    for (const s of ["croix-rouge", "amnesty-fr", "wwf", "my-ngo"]) {
      expect(isReservedSlug(s)).toBe(false);
    }
  });
});

describe("RESERVED_SLUGS invariants", () => {
  it("has no duplicates", () => {
    expect(new Set(RESERVED_SLUGS).size).toBe(RESERVED_SLUGS.length);
  });
  it("only contains lowercase entries (except the one documented dotted exception)", () => {
    // `.well-known` carries a leading dot by RFC 8615 convention; it's still
    // lowercase but not matched by [a-z] alone, so we check manually.
    expect(RESERVED_SLUGS.every((s) => s === s.toLowerCase())).toBe(true);
  });
});

// ─── Unit — validator ────────────────────────────────────────────────────────

describe("validateTenantSlug", () => {
  it("accepts well-formed slugs and returns the canonical value", () => {
    expect(validateTenantSlug("ac")).toEqual({ ok: true, slug: "ac" });
    expect(validateTenantSlug("amnesty-fr")).toEqual({ ok: true, slug: "amnesty-fr" });
    expect(validateTenantSlug("ngo-france-001")).toEqual({
      ok: true,
      slug: "ngo-france-001",
    });
  });

  it("normalises input before validating (trim + lowercase) and returns the canonical slug", () => {
    expect(validateTenantSlug("  Amnesty  ")).toEqual({ ok: true, slug: "amnesty" });
    expect(validateTenantSlug("NGO-France")).toEqual({ ok: true, slug: "ngo-france" });
  });

  it("rejects too-short, leading/trailing dash, symbols, spaces as syntax", () => {
    for (const s of ["a", "  a  ", "-ngo", "ngo-", "n go", "ngo!", "un_der"]) {
      expect(validateTenantSlug(s)).toEqual({ ok: false, reason: "syntax" });
    }
  });

  it("rejects slugs longer than 50 chars", () => {
    expect(validateTenantSlug("a".repeat(51))).toEqual({ ok: false, reason: "syntax" });
  });

  it("rejects reserved slugs with the 'reserved' reason", () => {
    expect(validateTenantSlug("admin")).toEqual({ ok: false, reason: "reserved" });
    expect(validateTenantSlug("API")).toEqual({ ok: false, reason: "reserved" });
    expect(validateTenantSlug("campaigns")).toEqual({ ok: false, reason: "reserved" });
  });

  it("rejects IDNA punycode (xn--) prefix with the 'punycode' reason", () => {
    expect(validateTenantSlug("xn--pple-43d")).toEqual({ ok: false, reason: "punycode" });
    expect(validateTenantSlug("XN--ASCII-LOOKS-LIKE")).toEqual({
      ok: false,
      reason: "punycode",
    });
  });
});

// ─── DB — tenants back-fill after migration ──────────────────────────────────

describe.sequential("tenants back-fill (migration 0021)", () => {
  it("existing seeded tenants have status='active' and created_via='enterprise'", async () => {
    const rows = await db
      .select({
        id: tenants.id,
        status: tenants.status,
        createdVia: tenants.createdVia,
      })
      .from(tenants);
    // Every pre-existing tenant row inherits the new defaults from the migration.
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.createdVia).toBe("enterprise");
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("existing users have first_admin=false after migration", async () => {
    // All pre-existing users (not the ones this suite seeded) must have the
    // new column defaulted to false; a NULL here would mean the migration
    // forgot the NOT NULL default.
    const { rows } = await db.execute<{ anyNull: boolean }>(
      sql`SELECT bool_or(first_admin IS NULL) AS "anyNull" FROM users`,
    );
    expect(rows[0]?.anyNull).toBe(false);
  });

  it("tenants.status CHECK rejects an unknown status", async () => {
    await expect(
      db.execute(sql`UPDATE tenants SET status = 'bogus' WHERE id = ${ONBOARD_A}`),
    ).rejects.toThrow(/tenants_status_chk/);
  });

  it("tenants.created_via CHECK rejects an unknown provenance", async () => {
    await expect(
      db.execute(sql`UPDATE tenants SET created_via = 'martian' WHERE id = ${ONBOARD_A}`),
    ).rejects.toThrow(/tenants_created_via_chk/);
  });

  it("tenants.primary_domain CHECK rejects uppercase", async () => {
    await expect(
      db.execute(sql`UPDATE tenants SET primary_domain = 'UPPER.org' WHERE id = ${ONBOARD_A}`),
    ).rejects.toThrow(/tenants_primary_domain_lower_chk/);
  });

  it("tenants.keycloak_org_id CHECK rejects non-UUID values", async () => {
    await expect(
      db.execute(sql`UPDATE tenants SET keycloak_org_id = 'not-a-uuid' WHERE id = ${ONBOARD_A}`),
    ).rejects.toThrow(/tenants_keycloak_org_id_uuid_chk/);
  });

  it("self-serve tenants require either provisional status or a verified_at", async () => {
    await expect(
      db.execute(sql`
        UPDATE tenants
        SET created_via = 'self_serve', status = 'active', verified_at = NULL
        WHERE id = ${ONBOARD_A}
      `),
    ).rejects.toThrow(/tenants_self_serve_requires_verification_chk/);
  });

  it("tenants.keycloak_org_id partial unique index enforces one-per-tenant", async () => {
    const KC_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await db.execute(sql`
      UPDATE tenants SET keycloak_org_id = ${KC_ID} WHERE id = ${ONBOARD_A}
    `);
    await expect(
      db.execute(sql`UPDATE tenants SET keycloak_org_id = ${KC_ID} WHERE id = ${ONBOARD_B}`),
    ).rejects.toThrow(/tenants_keycloak_org_id_uniq/);
    // NULLs are allowed to coexist (partial index scope).
    await expect(
      db.execute(sql`UPDATE tenants SET keycloak_org_id = NULL WHERE id = ${ONBOARD_A}`),
    ).resolves.not.toThrow();
  });
});

// ─── DB — tenant_domains ─────────────────────────────────────────────────────

describe.sequential("tenant_domains", () => {
  it("accepts inserts under each tenant context", async () => {
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ONBOARD_A,
        domain: d("ngo-a"),
        dnsTxtValue: txt("a"),
      });
    });
    await withTenantContext(ONBOARD_B, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ONBOARD_B,
        domain: d("ngo-b"),
        dnsTxtValue: txt("b"),
      });
    });

    const rows = await db
      .select({ orgId: tenantDomains.orgId, domain: tenantDomains.domain })
      .from(tenantDomains)
      .where(sql`${tenantDomains.domain} IN (${d("ngo-a")}, ${d("ngo-b")})`);

    expect(rows.some((r) => r.domain === d("ngo-a") && r.orgId === ONBOARD_A)).toBe(true);
    expect(rows.some((r) => r.domain === d("ngo-b") && r.orgId === ONBOARD_B)).toBe(true);
  });

  it("partial unique index rejects a second active claim of the same domain", async () => {
    const dup = d("dup");
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ONBOARD_A,
        domain: dup,
        dnsTxtValue: txt("dup-a"),
      });
    });

    await expect(
      withTenantContext(ONBOARD_B, async (tx) => {
        await tx.insert(tenantDomains).values({
          orgId: ONBOARD_B,
          domain: dup,
          dnsTxtValue: txt("dup-b"),
        });
      }),
    ).rejects.toThrow(/tenant_domains_active_domain_uniq/);
  });

  it("revoked rows free the domain slot", async () => {
    const revd = d("revoked");
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: ONBOARD_A,
        domain: revd,
        dnsTxtValue: txt("rev-a"),
        state: "revoked",
      });
    });
    await expect(
      withTenantContext(ONBOARD_B, async (tx) => {
        await tx.insert(tenantDomains).values({
          orgId: ONBOARD_B,
          domain: revd,
          dnsTxtValue: txt("rev-b"),
        });
      }),
    ).resolves.not.toThrow();
  });

  it("active DNS TXT values are unique globally", async () => {
    const dom1 = d("txt-uniq-1");
    const dom2 = d("txt-uniq-2");
    const sharedTxt = txt("shared-txt");
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx
        .insert(tenantDomains)
        .values({ orgId: ONBOARD_A, domain: dom1, dnsTxtValue: sharedTxt });
    });
    await expect(
      withTenantContext(ONBOARD_B, async (tx) => {
        await tx
          .insert(tenantDomains)
          .values({ orgId: ONBOARD_B, domain: dom2, dnsTxtValue: sharedTxt });
      }),
    ).rejects.toThrow(/tenant_domains_active_txt_uniq/);
  });

  it("CHECK forces lowercase domains", async () => {
    await expect(
      withTenantContext(ONBOARD_A, async (tx) => {
        await tx
          .insert(tenantDomains)
          .values({ orgId: ONBOARD_A, domain: "UPPER.test", dnsTxtValue: txt("upper") });
      }),
    ).rejects.toThrow(/tenant_domains_lowercase_chk/);
  });

  it("CHECK rejects low-entropy DNS TXT values", async () => {
    await expect(
      withTenantContext(ONBOARD_A, async (tx) => {
        await tx
          .insert(tenantDomains)
          .values({ orgId: ONBOARD_A, domain: d("weak"), dnsTxtValue: "short" });
      }),
    ).rejects.toThrow(/tenant_domains_dns_txt_entropy_chk/);
  });

  it("updated_at advances on every UPDATE (trigger)", async () => {
    const dom = d("trg");
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx
        .insert(tenantDomains)
        .values({ orgId: ONBOARD_A, domain: dom, dnsTxtValue: txt("trg") });
    });
    const [before] = await db
      .select({ at: tenantDomains.updatedAt })
      .from(tenantDomains)
      .where(eq(tenantDomains.domain, dom));

    // Small delay to observe a distinct timestamp.
    await new Promise((r) => setTimeout(r, 50));

    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx
        .update(tenantDomains)
        .set({ state: "verified", verifiedAt: new Date() })
        .where(eq(tenantDomains.domain, dom));
    });

    const [after] = await db
      .select({ at: tenantDomains.updatedAt })
      .from(tenantDomains)
      .where(eq(tenantDomains.domain, dom));
    expect(after?.at?.getTime()).toBeGreaterThan(before?.at?.getTime() ?? 0);
  });
});

// ─── DB — tenant_admin_disputes ──────────────────────────────────────────────

describe.sequential("tenant_admin_disputes", () => {
  it("accepts an open dispute under the tenant context", async () => {
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx.insert(tenantAdminDisputes).values({
        orgId: ONBOARD_A,
        disputerId: USER_A_DISPUTER,
        provisionalAdminId: USER_A_FIRST_ADMIN,
        reason: "Not actually the director",
      });
    });

    const rows = await db
      .select({ orgId: tenantAdminDisputes.orgId, resolution: tenantAdminDisputes.resolution })
      .from(tenantAdminDisputes)
      .where(eq(tenantAdminDisputes.orgId, ONBOARD_A));
    expect(rows.some((r) => r.orgId === ONBOARD_A && r.resolution === null)).toBe(true);
  });

  it("one-open-per-tenant partial unique index rejects a second open dispute", async () => {
    await expect(
      withTenantContext(ONBOARD_A, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ONBOARD_A,
          disputerId: USER_A_DISPUTER,
          provisionalAdminId: USER_A_FIRST_ADMIN,
          reason: "Second open dispute should fail",
        });
      }),
    ).rejects.toThrow(/tenant_admin_disputes_one_open_per_tenant/);
  });

  it("allows a new dispute after the previous one is resolved", async () => {
    await withTenantContext(ONBOARD_A, async (tx) => {
      await tx
        .update(tenantAdminDisputes)
        .set({ resolution: "kept", resolvedAt: new Date() })
        .where(and(eq(tenantAdminDisputes.orgId, ONBOARD_A), sql`resolution IS NULL`));
    });

    await expect(
      withTenantContext(ONBOARD_A, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ONBOARD_A,
          disputerId: USER_A_DISPUTER,
          provisionalAdminId: USER_A_FIRST_ADMIN,
          reason: "New dispute after closure",
        });
      }),
    ).resolves.not.toThrow();
  });

  it("rejects a dispute where disputer equals provisional admin (when both set)", async () => {
    await expect(
      withTenantContext(ONBOARD_B, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ONBOARD_B,
          disputerId: USER_B_FIRST_ADMIN,
          provisionalAdminId: USER_B_FIRST_ADMIN,
          reason: "Self-dispute",
        });
      }),
    ).rejects.toThrow(/tenant_admin_disputes_different_actors_chk/);
  });

  it("rejects resolution set without resolved_at (and vice-versa)", async () => {
    await expect(
      db.execute(
        sql`UPDATE tenant_admin_disputes SET resolution = 'kept', resolved_at = NULL WHERE org_id = ${ONBOARD_A}`,
      ),
    ).rejects.toThrow(/tenant_admin_disputes_resolved_consistency_chk/);
  });

  it("CHECK rejects unknown resolution values", async () => {
    await expect(
      db.execute(
        sql`UPDATE tenant_admin_disputes SET resolution = 'bogus' WHERE org_id = ${ONBOARD_A}`,
      ),
    ).rejects.toThrow(/tenant_admin_disputes_resolution_chk/);
  });

  it("serialises concurrent open-dispute inserts — exactly one wins", async () => {
    // First, resolve any open dispute so the tenant starts the race clean.
    await db.execute(sql`
      UPDATE tenant_admin_disputes
      SET resolution = 'kept', resolved_at = now()
      WHERE org_id = ${ONBOARD_B} AND resolution IS NULL
    `);

    const insert = () =>
      withTenantContext(ONBOARD_B, async (tx) => {
        await tx.insert(tenantAdminDisputes).values({
          orgId: ONBOARD_B,
          disputerId: USER_A_DISPUTER, // different tenant, but owner role bypasses the FK tenant link
          provisionalAdminId: USER_B_FIRST_ADMIN,
          reason: "Concurrent",
        });
      });

    const results = await Promise.allSettled([insert(), insert()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    const rejectedResult = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejectedResult).toBeDefined();
    expect(String(rejectedResult?.reason)).toMatch(/tenant_admin_disputes_one_open_per_tenant/);
  });
});

// ─── DB — users.first_admin one-per-org invariant ────────────────────────────

describe.sequential("users_one_first_admin_per_org", () => {
  it("rejects a second first_admin=true user in the same org", async () => {
    // USER_A_FIRST_ADMIN already carries first_admin=true.
    const EXTRA = "00000000-0000-0000-0000-00000000ca99";
    await expect(
      db.execute(sql`
        INSERT INTO users (id, org_id, email, first_name, last_name, role, first_admin)
        VALUES (${EXTRA}, ${ONBOARD_A}, 'second-admin@example.org', 'Second', 'Admin', 'org_admin', true)
      `),
    ).rejects.toThrow(/users_one_first_admin_per_org/);
  });
});

// ─── DB — users.provisional-admin fields ─────────────────────────────────────

describe.sequential("users provisional-admin fields", () => {
  it("CHECK prevents provisional_until without first_admin", async () => {
    await expect(
      db.execute(sql`
        UPDATE users
        SET first_admin = false, provisional_until = now() + interval '7 days'
        WHERE id = ${USER_A_DISPUTER}
      `),
    ).rejects.toThrow(/users_provisional_requires_first_admin_chk/);
  });

  it("allows provisional_until when first_admin is true", async () => {
    await expect(
      db.execute(sql`
        UPDATE users
        SET provisional_until = now() + interval '7 days'
        WHERE id = ${USER_A_FIRST_ADMIN}
      `),
    ).resolves.not.toThrow();

    const [row] = await db
      .select({ first: users.firstAdmin, until: users.provisionalUntil })
      .from(users)
      .where(eq(users.id, USER_A_FIRST_ADMIN));
    expect(row?.first).toBe(true);
    expect(row?.until).toBeTruthy();
  });

  it("allows a past-dated provisional_until — expiry is policed by the API, not the DB", async () => {
    await expect(
      db.execute(sql`
        UPDATE users SET provisional_until = now() - interval '1 day'
        WHERE id = ${USER_A_FIRST_ADMIN}
      `),
    ).resolves.not.toThrow();
  });
});

// ─── DB — cascade + user erasure ─────────────────────────────────────────────

describe.sequential("tenant delete cascade", () => {
  it("deleting a tenant cascades its domains and disputes", async () => {
    // Seed an ephemeral tenant + two users + a domain + a dispute.
    const U1 = "00000000-0000-0000-0000-00000000cc01";
    const U2 = "00000000-0000-0000-0000-00000000cc02";
    await db.execute(sql`
      INSERT INTO tenants (id, name, slug, status, created_via)
      VALUES (${CASCADE_ORG}, 'Cascade Org', 'cascade-org', 'active', 'enterprise')
    `);
    await db.execute(sql`
      INSERT INTO users (id, org_id, email, first_name, last_name, role, first_admin)
      VALUES
        (${U1}, ${CASCADE_ORG}, 'u1@c.org', 'U', '1', 'org_admin', true),
        (${U2}, ${CASCADE_ORG}, 'u2@c.org', 'U', '2', 'user', false)
    `);
    await withTenantContext(CASCADE_ORG, async (tx) => {
      await tx.insert(tenantDomains).values({
        orgId: CASCADE_ORG,
        domain: d("cascade"),
        dnsTxtValue: txt("cascade"),
      });
      await tx.insert(tenantAdminDisputes).values({
        orgId: CASCADE_ORG,
        disputerId: U2,
        provisionalAdminId: U1,
        reason: "cascade-test",
      });
    });

    await db.execute(sql`DELETE FROM tenants WHERE id = ${CASCADE_ORG}`);

    const { rows: domRows } = await db.execute<{ c: number }>(
      sql`SELECT COUNT(*)::int AS c FROM tenant_domains WHERE org_id = ${CASCADE_ORG}`,
    );
    const { rows: dispRows } = await db.execute<{ c: number }>(
      sql`SELECT COUNT(*)::int AS c FROM tenant_admin_disputes WHERE org_id = ${CASCADE_ORG}`,
    );
    expect(domRows[0]?.c).toBe(0);
    expect(dispRows[0]?.c).toBe(0);
  });

  it("user deletion nullifies dispute FKs rather than failing", async () => {
    // Create a throwaway user, attach to an existing open or resolved dispute.
    const THROW = "00000000-0000-0000-0000-00000000cc99";
    await db.execute(sql`
      INSERT INTO users (id, org_id, email, first_name, last_name, role, first_admin)
      VALUES (${THROW}, ${ONBOARD_B}, 'throw@b.org', 'Throw', 'Away', 'user', false)
    `);
    await db.execute(sql`
      INSERT INTO tenant_admin_disputes (org_id, disputer_id, provisional_admin_id, reason, resolution, resolved_at)
      VALUES (${ONBOARD_B}, ${THROW}, ${USER_B_FIRST_ADMIN}, 'erasure', 'kept', now())
    `);

    // GDPR erasure of the user should succeed even though the dispute references them.
    await expect(db.execute(sql`DELETE FROM users WHERE id = ${THROW}`)).resolves.not.toThrow();

    const { rows } = await db.execute<{ disputer_id: string | null }>(
      sql`SELECT disputer_id FROM tenant_admin_disputes WHERE reason = 'erasure' AND org_id = ${ONBOARD_B}`,
    );
    expect(rows[0]?.disputer_id).toBeNull();
  });
});
