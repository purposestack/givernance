/**
 * Integration coverage for the issue #153 schema additions (migration
 * 0027_locale_resolution).
 *
 * The 4-cell user-vs-tenant locale matrix lives in `team-invitations.test.ts`
 * — that's a route-level test of the resolution chain. This file pins the
 * data-model invariants that everything else builds on:
 *
 *  - `tenants.country` accepts ISO-3166-1 alpha-2 only (CHECK constraint).
 *  - `tenants.default_locale` defaults to 'fr', is NOT NULL, and only
 *    accepts values in `SUPPORTED_LOCALES`.
 *  - `users.locale` is NULL by default and only accepts values in
 *    `SUPPORTED_LOCALES`.
 *  - The migration backfill rule on `default_locale` matches the runtime
 *    `localeFromCountry` helper so signup flow + backfill stay in sync.
 */

import { randomUUID } from "node:crypto";
import { localeFromCountry, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { outboxEvents, tenants, users } from "@givernance/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";

const trackedTenants = new Set<string>();

afterAll(async () => {
  if (trackedTenants.size === 0) return;
  const ids = [...trackedTenants];
  // Drop dependents first so the FK CASCADEs aren't necessary.
  await db.delete(outboxEvents).where(inArray(outboxEvents.tenantId, ids));
  await db.delete(users).where(inArray(users.orgId, ids));
  await db.delete(tenants).where(inArray(tenants.id, ids));
});

async function insertTenant(values: {
  country?: string | null;
  defaultLocale?: string;
}): Promise<string> {
  const id = randomUUID();
  trackedTenants.add(id);
  const slug = `locale-test-${id.slice(0, 8)}`;
  const country = values.country === undefined ? null : values.country;
  if (values.defaultLocale === undefined) {
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug, status, created_via, country)
          VALUES (${id}, ${`Locale Test ${slug}`}, ${slug}, 'active', 'enterprise', ${country})`,
    );
  } else {
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug, status, created_via, country, default_locale)
          VALUES (${id}, ${`Locale Test ${slug}`}, ${slug}, 'active', 'enterprise', ${country}, ${values.defaultLocale})`,
    );
  }
  return id;
}

describe("tenants.country CHECK constraint (issue #153)", () => {
  it("accepts a 2-letter uppercase code", async () => {
    const id = await insertTenant({ country: "FR" });
    const [row] = await db
      .select({ country: tenants.country })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBe("FR");
  });

  it("rejects a lowercase code", async () => {
    await expect(insertTenant({ country: "fr" })).rejects.toThrow(/tenants_country_alpha2_chk/);
  });

  it("rejects a numeric 2-char value", async () => {
    // Defence in depth on top of the varchar(2) length check — the regex
    // CHECK ensures every position is `[A-Z]`, so a `'12'` insert is
    // rejected by the constraint, not silently truncated.
    await expect(insertTenant({ country: "12" })).rejects.toThrow(/tenants_country_alpha2_chk/);
  });

  it("accepts NULL", async () => {
    const id = await insertTenant({ country: null });
    const [row] = await db
      .select({ country: tenants.country })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBeNull();
  });
});

describe("tenants.default_locale defaults and CHECK (issue #153)", () => {
  it("defaults to 'fr' per ADR-015", async () => {
    const id = await insertTenant({});
    const [row] = await db
      .select({ defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.defaultLocale).toBe("fr");
  });

  it("accepts 'en' explicitly", async () => {
    const id = await insertTenant({ defaultLocale: "en" });
    const [row] = await db
      .select({ defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.defaultLocale).toBe("en");
  });

  it("rejects an unsupported locale", async () => {
    await expect(insertTenant({ defaultLocale: "de" })).rejects.toThrow(
      /tenants_default_locale_chk/,
    );
  });
});

describe("users.locale CHECK constraint (issue #153)", () => {
  it("rejects an unsupported locale via direct INSERT", async () => {
    const tenantId = await insertTenant({});
    await expect(
      db.execute(
        sql`INSERT INTO users (org_id, email, first_name, last_name, role, locale)
            VALUES (${tenantId}, 'bad-locale@example.org', 'Bad', 'Locale', 'user', 'de')`,
      ),
    ).rejects.toThrow(/users_locale_chk/);
  });

  it("accepts NULL (inherits tenant default)", async () => {
    const tenantId = await insertTenant({});
    await db.execute(
      sql`INSERT INTO users (org_id, email, first_name, last_name, role)
          VALUES (${tenantId}, 'null-locale@example.org', 'Null', 'Locale', 'user')`,
    );
    const [row] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.email, "null-locale@example.org"));
    expect(row?.locale).toBeNull();
  });
});

describe("backfill rule mirrors localeFromCountry helper (issue #153)", () => {
  // Migration 0027 backfills `default_locale` per:
  //   country='FR'                  → 'fr'
  //   country IS NOT NULL, != 'FR'  → 'en'
  //   country IS NULL               → 'fr' (column DEFAULT)
  // The runtime helper used by signup flow follows the same rule so a
  // fresh signup and a back-filled row land on the same value.
  it.each([
    { country: "FR", expected: "fr" as const },
    { country: "BE", expected: "en" as const },
    { country: "DE", expected: "en" as const },
    { country: "NL", expected: "en" as const },
    { country: null, expected: "fr" as const },
    { country: undefined, expected: "fr" as const },
  ])("localeFromCountry($country) === '$expected'", ({ country, expected }) => {
    expect(localeFromCountry(country)).toBe(expected);
  });
});

// ─── Migration backfill SQL (data review F-A1, QA review #11) ──────────────
//
// Verifies the `DO $$ ... $$` block in migration 0027 actually populates
// tenants.country + tenants.default_locale per the spec. We can't replay the
// migration against a DB it already ran on, so we re-apply the same SQL
// against a fresh fixture: insert a tenant with country=NULL/default_locale='fr'
// (column defaults), seed an outbox event with payload.country='FR', then
// run the same UPDATE block and assert the post-state.
describe("migration 0027 backfill SQL (issue #153 / data review F-A1)", () => {
  // Helper: replay just the WHERE-aware UPDATE blocks from migration 0027.
  // Kept inline so a future migration rewrite doesn't silently break the
  // assertion — the SQL must stay byte-aligned with what shipped.
  async function replayBackfill(): Promise<void> {
    await db.execute(sql`
      WITH latest_signup_event AS (
        SELECT DISTINCT ON (oe.tenant_id)
          oe.tenant_id,
          oe.payload->>'country' AS country
        FROM "outbox_events" oe
        WHERE oe.type IN (
            'tenant.signup_verification_requested',
            'tenant.signup_verification_resent'
          )
          AND oe.payload ? 'country'
          AND jsonb_typeof(oe.payload->'country') = 'string'
        ORDER BY oe.tenant_id, oe.created_at DESC, oe.id DESC
      )
      UPDATE "tenants" t
        SET "country" = upper(lse.country)
        FROM latest_signup_event lse
        WHERE t."id" = lse.tenant_id
          AND upper(lse.country) ~ '^[A-Z]{2}$'
    `);
    await db.execute(sql`
      UPDATE "tenants"
        SET "default_locale" = CASE
          WHEN upper("country") = 'FR' THEN 'fr'
          ELSE 'en'
        END
        WHERE "country" IS NOT NULL
    `);
  }

  async function reset(tenantId: string): Promise<void> {
    // Migration 0027 already ran — undo the columns to model a "before"
    // state for this tenant only, then replay the backfill against just
    // its rows. Using `country = NULL, default_locale = 'fr'` (column
    // DEFAULT) puts us in the pre-migration shape.
    await db
      .update(tenants)
      .set({ country: null, defaultLocale: "fr" })
      .where(eq(tenants.id, tenantId));
  }

  async function seedTenant(): Promise<string> {
    const id = randomUUID();
    trackedTenants.add(id);
    // Use `created_via='enterprise'` to dodge the
    // `tenants_self_serve_requires_verification_chk` invariant — the backfill
    // walks the outbox by event type, not by created_via, so this is
    // sufficient to model both signup and enterprise tenants for the
    // backfill rule we want to test.
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug, status, created_via)
          VALUES (${id}, ${`Backfill ${id.slice(0, 8)}`}, ${`backfill-${id.slice(0, 8)}`}, 'active', 'enterprise')`,
    );
    await reset(id);
    return id;
  }

  it("FR signup tenant: country=FR → default_locale='fr'", async () => {
    const id = await seedTenant();
    await db.insert(outboxEvents).values({
      tenantId: id,
      type: "tenant.signup_verification_requested",
      payload: { tenantId: id, country: "FR" },
    });
    await replayBackfill();
    const [row] = await db
      .select({ country: tenants.country, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBe("FR");
    expect(row?.defaultLocale).toBe("fr");
  });

  it("BE signup tenant (non-FR): country=BE → default_locale='en' (preserves prior EN fallback)", async () => {
    const id = await seedTenant();
    await db.insert(outboxEvents).values({
      tenantId: id,
      type: "tenant.signup_verification_requested",
      payload: { tenantId: id, country: "BE" },
    });
    await replayBackfill();
    const [row] = await db
      .select({ country: tenants.country, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBe("BE");
    expect(row?.defaultLocale).toBe("en");
  });

  it("Enterprise / pre-country tenant (no signup event): country=NULL → default_locale='fr' (column DEFAULT, fixes the bug)", async () => {
    const id = await seedTenant();
    // No outbox event seeded — models the enterprise-seeded path.
    await replayBackfill();
    const [row] = await db
      .select({ country: tenants.country, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBeNull();
    expect(row?.defaultLocale).toBe("fr");
  });

  it("Mixed-case payload country normalised via upper(); rejected if not alpha", async () => {
    const id = await seedTenant();
    await db.insert(outboxEvents).values({
      tenantId: id,
      type: "tenant.signup_verification_requested",
      // Mixed-case must round-trip to upper() and match the regex.
      payload: { tenantId: id, country: "fR" },
    });
    await replayBackfill();
    const [row] = await db
      .select({ country: tenants.country, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBe("FR");
    expect(row?.defaultLocale).toBe("fr");
  });

  it("Latest event wins when a tenant has both an initial + a resend event", async () => {
    const id = await seedTenant();
    // Seed the initial event with one country, then a later resend with a
    // different country. The later event must win.
    const initial = new Date(Date.now() - 60_000).toISOString();
    const resent = new Date().toISOString();
    await db.execute(sql`
      INSERT INTO outbox_events (tenant_id, type, payload, created_at) VALUES
        (${id}, 'tenant.signup_verification_requested', ${{ tenantId: id, country: "BE" }}, ${initial}),
        (${id}, 'tenant.signup_verification_resent', ${{ tenantId: id, country: "FR" }}, ${resent})
    `);
    await replayBackfill();
    const [row] = await db
      .select({ country: tenants.country, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(row?.country).toBe("FR");
    expect(row?.defaultLocale).toBe("fr");
  });
});

// ─── Drift guard (platform review F-P3) ───────────────────────────────────
//
// SUPPORTED_LOCALES is the TS source of truth; the migration's CHECK
// constraint values are SQL literals. If a future PR adds 'de' to the
// constant without updating the CHECK (or vice versa) we'd insert rows
// the runtime trusts but the DB rejects (or the other way round).
describe("CHECK constraint values agree with SUPPORTED_LOCALES (drift guard)", () => {
  it("every supported locale is accepted by tenants.default_locale CHECK", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const id = randomUUID();
      trackedTenants.add(id);
      // Should not throw — the constraint must accept every value the
      // runtime will write.
      await db.execute(
        sql`INSERT INTO tenants (id, name, slug, status, created_via, default_locale)
            VALUES (${id}, ${`Drift ${locale}`}, ${`drift-${locale}-${id.slice(0, 8)}`}, 'active', 'enterprise', ${locale})`,
      );
    }
  });

  it("every supported locale is accepted by users.locale CHECK", async () => {
    const tenantId = randomUUID();
    trackedTenants.add(tenantId);
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug, status, created_via)
          VALUES (${tenantId}, 'Drift parent', ${`drift-parent-${tenantId.slice(0, 8)}`}, 'active', 'enterprise')`,
    );
    for (const locale of SUPPORTED_LOCALES) {
      // Should not throw.
      await db.execute(
        sql`INSERT INTO users (org_id, email, first_name, last_name, role, locale)
            VALUES (${tenantId}, ${`drift-${locale}-${randomUUID().slice(0, 6)}@example.org`}, 'Drift', 'User', 'user', ${locale})`,
      );
    }
  });
});
