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
import { localeFromCountry } from "@givernance/shared/i18n";
import { tenants, users } from "@givernance/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";

const trackedTenants = new Set<string>();

afterAll(async () => {
  if (trackedTenants.size === 0) return;
  const ids = [...trackedTenants];
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
