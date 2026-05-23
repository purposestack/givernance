/**
 * Development database seed — populates the "Givernance Demo NPO" tenant
 * with realistic but fake constituents, campaigns, and donations so the
 * frontend (issue #41, PR-B2) has data to render, plus a second empty
 * tenant ("Demo Workspace") that exists purely as an impersonation
 * playground.
 *
 * Run with:
 *   pnpm --filter @givernance/api run db:seed
 *
 * Tenancy layout (ADR-022):
 *   - **Demo NPO** (`…c1`) — realistic data; the operator practises support
 *     scenarios here. This is a regular customer tenant, not a platform
 *     tenant, so org-admins inside it are valid impersonation targets.
 *   - **Demo Workspace** (`…b1`) — empty tenant with three pre-seeded users
 *     (org_admin / user / viewer) for clean-flow impersonation testing.
 *   - **Super-admin** lands in `platform_admins` (no `org_id`, no tenant
 *     row). The Keycloak side keeps the "Givernance Platform" Organization
 *     with `org_id` attribute `…a1` for the OIDC mapper, but no app-DB
 *     `tenants` row exists at that id by design.
 *
 * If a pre-existing tenant holds the Demo NPO slug under a different id
 * (e.g. created via the signup flow), its slug is renamed to free the
 * fixture slot rather than reused — this prevents id drift that otherwise
 * yields 404s on tenant-scoped admin routes. Constituents/campaigns/donations
 * are inserted fresh on every run. Intended for local dev only — never
 * run against production.
 */

import {
  campaigns,
  constituents,
  donations,
  impersonationSessions,
  platformAdmins,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, systemDb, withTenantContext } from "../src/lib/db.js";

const TENANT_SLUG = "givernance";
const TENANT_NAME = "Givernance Demo NPO";
/**
 * Fresh UUID for "Givernance Demo NPO" — a regular customer tenant that
 * holds the seeded realistic data. Deliberately NOT `…a1` (which is the
 * Keycloak platform Organization's `org_id` attribute, no longer mirrored
 * in `tenants`; ADR-022).
 */
const TENANT_ID = "00000000-0000-0000-0000-0000000000c1";

/**
 * Second dev tenant — empty impersonation playground. Three pre-seeded
 * users in distinct roles so the operator can practise pure-impersonation
 * vs delegation flows without the noise of realistic data. Distinct UUID
 * (`…b1`) so it's obvious in fixtures and audit logs.
 */
const DEMO_TENANT_ID = "00000000-0000-0000-0000-0000000000b1";
const DEMO_TENANT_SLUG = "givernance-demo";
const DEMO_TENANT_NAME = "Demo Workspace (impersonation playground)";

const DEMO_USERS = [
  {
    keycloakId: "00000000-0000-0000-0000-0000000000b1",
    firstName: "Camille",
    lastName: "Bernard",
    email: "camille.bernard@demo.givernance.local",
    role: "org_admin",
  },
  {
    keycloakId: "00000000-0000-0000-0000-0000000000b2",
    firstName: "Léo",
    lastName: "Martin",
    email: "leo.martin@demo.givernance.local",
    role: "user",
  },
  {
    keycloakId: "00000000-0000-0000-0000-0000000000b3",
    firstName: "Inès",
    lastName: "Dubois",
    email: "ines.dubois@demo.givernance.local",
    role: "viewer",
  },
] as const;
/**
 * Fixed Keycloak `sub` for the seeded super-admin (ADR-022). Pinned to
 * the `id` field on `admin@givernance.org` in
 * `infra/keycloak/realm-givernance.json`. The `platform_admins` row inserted
 * below carries this in `keycloak_id` so that `GET /v1/users/me` resolves
 * the platform-admin profile when the super-admin logs in. Platform admins
 * have no `users` row and no tenant binding — their identity surface is
 * disjoint from tenant members by invariant.
 */
const ADMIN_KEYCLOAK_ID = "00000000-0000-0000-0000-000000000ad1";
const ADMIN_EMAIL = "admin@givernance.org";
const ADMIN_FIRST_NAME = "Super";
const ADMIN_LAST_NAME = "Admin";
const CONSTITUENT_COUNT = 50;
const CAMPAIGN_COUNT = 5;
const DONATION_COUNT = 100;

type ConstituentType = "donor" | "volunteer" | "member" | "beneficiary" | "partner";
type CampaignType = "nominative_postal" | "door_drop" | "digital";
type CampaignStatus = "draft" | "active" | "closed";

const INDIVIDUAL_FIRST_NAMES = [
  "Marie-Claire",
  "Ahmed",
  "Sophie",
  "Jean-Pierre",
  "Fatima",
  "Pierre",
  "Nadia",
  "François",
  "Camille",
  "Lucas",
  "Amélie",
  "Thomas",
  "Inès",
  "Paul",
  "Léa",
  "Karim",
  "Élise",
  "Antoine",
  "Yasmine",
  "Julien",
  "Claire",
  "Mehdi",
  "Hélène",
  "Victor",
  "Anna",
];

const INDIVIDUAL_LAST_NAMES = [
  "Fontaine",
  "Benali",
  "Martin",
  "Rousseau",
  "El Amrani",
  "Lefèvre",
  "Berger",
  "Dupont",
  "Moreau",
  "Laurent",
  "Garcia",
  "Bernard",
  "Richard",
  "Petit",
  "Durand",
  "Leroy",
  "Roux",
  "David",
  "Vincent",
  "Fournier",
  "Girard",
  "Bonnet",
  "Dupuis",
  "Morel",
  "Lambert",
];

const ORGANIZATION_PREFIXES = [
  "Fondation",
  "Association",
  "SAS",
  "Cabinet",
  "Groupe",
  "Société",
];

const ORGANIZATION_ROOTS = [
  "Solidarité",
  "Avenir",
  "Horizon",
  "Lumière",
  "Phénix",
  "Entraide",
  "Impact",
  "Liberté",
  "Renaissance",
  "Espoir",
];

const TAG_POOL = [
  "Fidèle",
  "Gala",
  "Récurrent",
  "Majeur",
  "Entreprise",
  "Accueil",
  "Programme Alpha",
  "Langues",
  "Nouveau",
];

const CAMPAIGN_BASE_NAMES = [
  "Campagne de fin d'année",
  "Appel de printemps",
  "Collecte spéciale inondations",
  "Gala de gala des bienfaiteurs",
  "Campagne digitale d'été",
  "Appel postal régional",
  "Relance annuelle",
];

function randomPick<T>(items: readonly T[]): T {
  const index = Math.floor(Math.random() * items.length);
  const value = items[index];
  if (value === undefined) {
    throw new Error("randomPick: empty array");
  }
  return value;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDateWithinLastYear(): Date {
  const now = Date.now();
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
  return new Date(randomInt(yearAgo, now));
}

function emailFromName(first: string, last: string, suffix: number): string {
  const normalized = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/(^\.|\.$)/g, "");
  return `${normalized(first)}.${normalized(last)}${suffix}@example.org`;
}

async function findOrCreateTenant(): Promise<string> {
  // Lookup must be by id, not by slug, so signup-created tenants sharing
  // the slug don't win the lookup and leave the seed misaligned.
  const [byId] = await db.select().from(tenants).where(eq(tenants.id, TENANT_ID));
  if (byId) {
    console.log(`[seed] Reusing tenant ${TENANT_SLUG} (${byId.id})`);
    return byId.id;
  }

  // If the slug is already held under a different id, rename the orphan
  // instead of reusing it — preserves its data but frees the fixture slot.
  const [bySlug] = await db.select().from(tenants).where(eq(tenants.slug, TENANT_SLUG));
  if (bySlug) {
    const rescuedSlug = `${TENANT_SLUG}-orphan-${Date.now()}`;
    await db.update(tenants).set({ slug: rescuedSlug }).where(eq(tenants.id, bySlug.id));
    console.warn(
      `[seed] Slug "${TENANT_SLUG}" was held by id=${bySlug.id}; renamed to "${rescuedSlug}" so the fixture id can claim it.`,
    );
  }

  const [created] = await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: TENANT_NAME,
      slug: TENANT_SLUG,
      plan: "starter",
      status: "active",
    })
    .returning();

  if (!created) {
    throw new Error("Failed to create tenant");
  }

  console.log(`[seed] Created tenant ${TENANT_SLUG} (${created.id})`);
  return created.id;
}

/**
 * Sentinel platform tenant row (ADR-022 amendment).
 *
 * `audit_logs.org_id` is `NOT NULL REFERENCES tenants(id)` — every audit
 * row needs a tenant to FK against. Platform-level lifecycle events
 * (super-admin onboarded/removed/etc., issue #254) don't belong to any
 * customer tenant by definition, so we keep ONE row in `tenants` at the
 * platform id (`…a1`) purely as the FK target for those audit rows.
 *
 * Distinguishing properties:
 *   - `status = 'archived'` so customer-facing listing endpoints
 *     (which already filter `status != 'archived'`) never surface it.
 *   - `slug = '__platform__'` (double-underscore is reserved by ADR-016
 *     reserved-slugs guard) so it cannot collide with any user-facing slug.
 *   - `name` is human-readable for SOC reviewers grepping the audit table.
 *
 * Other invariants preserved by ADR-022 (still true):
 *   - No super-admin `users` row in this tenant. Platform admins live in
 *     `platform_admins`.
 *   - No constituents / campaigns / donations are seeded under this id.
 *   - Customer-facing tenant lookups exclude `status = 'archived'`.
 */
const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-0000000000a1";
const PLATFORM_TENANT_SLUG = "__platform__";
const PLATFORM_TENANT_NAME = "Givernance Platform (sentinel)";

async function ensurePlatformSentinelTenant(): Promise<void> {
  const [existing] = await db
    .select({ id: tenants.id, status: tenants.status, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, PLATFORM_TENANT_ID));
  if (existing) {
    // Reconcile to the canonical sentinel state in case a previous seed
    // left it in a different shape. Idempotent on a no-op.
    if (existing.status !== "archived" || existing.slug !== PLATFORM_TENANT_SLUG) {
      await db
        .update(tenants)
        .set({ status: "archived", slug: PLATFORM_TENANT_SLUG, name: PLATFORM_TENANT_NAME })
        .where(eq(tenants.id, PLATFORM_TENANT_ID));
      console.log(
        `[seed] Reconciled platform sentinel tenant to canonical shape (${PLATFORM_TENANT_ID})`,
      );
    } else {
      console.log(`[seed] Platform sentinel tenant present (${PLATFORM_TENANT_ID})`);
    }
    return;
  }
  await db.insert(tenants).values({
    id: PLATFORM_TENANT_ID,
    name: PLATFORM_TENANT_NAME,
    slug: PLATFORM_TENANT_SLUG,
    plan: "starter",
    status: "archived",
  });
  console.log(
    `[seed] Created platform sentinel tenant ${PLATFORM_TENANT_ID} (audit FK target only).`,
  );
}

// French postal-address fixture pool for the seed (Epic #274 follow-up).
// 80% of constituents get a real-looking address so the postal-export
// preview demo has enough recipients with full addresses to validate the
// window-envelope layout end-to-end. The remaining 20% intentionally
// land without an address so the operator can see the renderer's
// "no address" branch (no in-window block, generic top-of-page
// letterhead) in action.
const STREET_NUMBERS = ["3", "5", "7", "12", "18", "24", "37", "42", "58", "73", "112"];
const STREET_NAMES = [
  "rue de la République",
  "rue Saint-Michel",
  "avenue Jean Jaurès",
  "boulevard Voltaire",
  "rue de la Paix",
  "rue des Lilas",
  "rue du Faubourg",
  "avenue de la Liberté",
  "rue des Acacias",
  "rue Pasteur",
  "place du Marché",
  "chemin de la Fontaine",
];
const FRENCH_CITIES: Array<[string, string]> = [
  ["75001", "Paris"],
  ["75011", "Paris"],
  ["69002", "Lyon"],
  ["13001", "Marseille"],
  ["31000", "Toulouse"],
  ["44000", "Nantes"],
  ["33000", "Bordeaux"],
  ["67000", "Strasbourg"],
  ["59000", "Lille"],
  ["35000", "Rennes"],
  ["38000", "Grenoble"],
  ["34000", "Montpellier"],
  ["54000", "Nancy"],
  ["49000", "Angers"],
];

function buildPostalAddress(): {
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
} {
  const [postalCode, city] = randomPick(FRENCH_CITIES);
  return {
    addressLine1: `${randomPick(STREET_NUMBERS)} ${randomPick(STREET_NAMES)}`,
    // 25% of addresses get a line 2 (apartment / building / floor) so
    // the renderer's optional second-line branch is exercised.
    addressLine2: Math.random() > 0.75 ? `Apt ${randomInt(1, 50)}` : null,
    postalCode,
    city,
    countryCode: "FR",
  };
}

function buildConstituent(index: number) {
  const isOrganization = index % 5 === 0;
  const types: ConstituentType[] = ["donor", "donor", "donor", "volunteer", "member", "partner"];
  const type: ConstituentType = isOrganization ? "partner" : randomPick(types);

  const firstName = isOrganization
    ? randomPick(ORGANIZATION_PREFIXES)
    : randomPick(INDIVIDUAL_FIRST_NAMES);
  const lastName = isOrganization
    ? randomPick(ORGANIZATION_ROOTS)
    : randomPick(INDIVIDUAL_LAST_NAMES);

  const tags = Math.random() > 0.5 ? [randomPick(TAG_POOL)] : [];
  if (Math.random() > 0.8) tags.push(randomPick(TAG_POOL));

  // 80% of seeded constituents carry a full postal address so the
  // postal-letter preview demo ships with enough recipients to fill a
  // window envelope. The renderer skips the address block when these
  // are NULL — keeping a 20% un-addressed cohort exercises that path.
  const address = Math.random() > 0.2 ? buildPostalAddress() : null;

  return {
    firstName,
    lastName,
    email: Math.random() > 0.1 ? emailFromName(firstName, lastName, index) : null,
    phone:
      Math.random() > 0.3
        ? `06 ${randomInt(10, 99)} ${randomInt(10, 99)} ${randomInt(10, 99)} ${randomInt(10, 99)}`
        : null,
    addressLine1: address?.addressLine1 ?? null,
    addressLine2: address?.addressLine2 ?? null,
    postalCode: address?.postalCode ?? null,
    city: address?.city ?? null,
    countryCode: address?.countryCode ?? null,
    type,
    tags: tags.length > 0 ? [...new Set(tags)] : null,
  };
}

function buildCampaign(index: number) {
  const types: CampaignType[] = ["nominative_postal", "door_drop", "digital"];
  const statuses: CampaignStatus[] = ["draft", "active", "active", "closed"];
  const base = CAMPAIGN_BASE_NAMES[index % CAMPAIGN_BASE_NAMES.length] ?? "Campagne";
  return {
    name: `${base} ${new Date().getFullYear() - (index % 2)}`,
    type: randomPick(types),
    status: randomPick(statuses),
    operationalCostCents: randomInt(50_000, 500_000),
  };
}

/**
 * Seed the data tables (constituents / campaigns / donations) for a tenant.
 *
 * Pure data — no users. Re-runnable inside a fresh tenant, but **not** truly
 * idempotent: every call appends `CONSTITUENT_COUNT` / `CAMPAIGN_COUNT` /
 * `DONATION_COUNT` rows, so callers must gate it (the dev-up.sh gate on
 * `c1.constituents = 0` is the production gate). User seeding is split out
 * to dedicated helpers so we can re-use this for the demo workspace tenant
 * without dragging the NPO-specific users along.
 */
async function seedOrgData(orgId: string, tenantLabel: string) {
  return withTenantContext(orgId, async (tx) => {
    // Constituents
    const constituentRows = Array.from({ length: CONSTITUENT_COUNT }, (_, i) => ({
      ...buildConstituent(i),
      orgId,
    }));
    const insertedConstituents = await tx
      .insert(constituents)
      .values(constituentRows)
      .returning({ id: constituents.id });
    console.log(`[seed][${tenantLabel}] Inserted ${insertedConstituents.length} constituents`);

    // Campaigns
    const campaignRows = Array.from({ length: CAMPAIGN_COUNT }, (_, i) => ({
      ...buildCampaign(i),
      orgId,
    }));
    const insertedCampaigns = await tx
      .insert(campaigns)
      .values(campaignRows)
      .returning({ id: campaigns.id });
    console.log(`[seed][${tenantLabel}] Inserted ${insertedCampaigns.length} campaigns`);

    // Donations — link each to a random constituent + ~80% to a campaign
    const paymentMethods = ["card", "sepa", "check", "cash", "bank_transfer"];
    const donationRows = Array.from({ length: DONATION_COUNT }, (_, i) => {
      const constituent = randomPick(insertedConstituents);
      const campaign = Math.random() > 0.2 ? randomPick(insertedCampaigns) : null;
      const donatedAt = randomDateWithinLastYear();
      const amountCents = randomInt(500, 500_000);
      return {
        orgId,
        constituentId: constituent.id,
        amountCents,
        currency: "EUR",
        exchangeRate: "1",
        amountBaseCents: amountCents,
        campaignId: campaign?.id ?? null,
        paymentMethod: randomPick(paymentMethods),
        // `paymentRef` includes the tenant label so cross-tenant seeds can't
        // collide on the `(org_id, paymentMethod, paymentRef)` unique even
        // if both tenants seed in the same millisecond.
        paymentRef: `SEED-${tenantLabel}-${Date.now()}-${i.toString().padStart(4, "0")}`,
        donatedAt,
        fiscalYear: donatedAt.getFullYear(),
      };
    });
    const insertedDonations = await tx
      .insert(donations)
      .values(donationRows)
      .returning({ id: donations.id });
    console.log(`[seed][${tenantLabel}] Inserted ${insertedDonations.length} donations`);
  });
}

/**
 * NPO-specific users for the realistic Demo NPO tenant. Pinned Keycloak ids
 * (`…c2`, `…c3`) so the realm import in `infra/keycloak/realm-givernance.json`
 * stays in lockstep. Idempotent: skips on email collision per tenant.
 */
async function seedNpoUsers(orgId: string) {
  const npoUsers = [
    {
      email: "alice@npo.local",
      firstName: "Alice",
      lastName: "NPO",
      role: "org_admin" as const,
      keycloakId: "00000000-0000-0000-0000-0000000000c2",
    },
    {
      email: "bob@npo.local",
      firstName: "Bob",
      lastName: "Staff",
      role: "user" as const,
      keycloakId: "00000000-0000-0000-0000-0000000000c3",
    },
  ];

  return withTenantContext(orgId, async (tx) => {
    for (const u of npoUsers) {
      const [present] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, u.email))
        .limit(1);
      if (!present) {
        try {
          await tx.insert(users).values({ ...u, orgId });
          console.log(`[seed][demo-npo] Inserted NPO user ${u.email} (${u.role})`);
        } catch {
          console.warn(
            `[seed][demo-npo] Skipped NPO user ${u.email} (already exists or constraint violation)`,
          );
        }
      }
    }
  });
}

/**
 * Idempotently seed a `platform_admins` row for the super-admin so
 * `GET /v1/users/me` can resolve a profile when admin@givernance.org logs
 * in (ADR-022). The Keycloak realm import creates the user on the IdP
 * side; the application DB needs a matching `platform_admins` row keyed
 * on `keycloak_id` for the sidebar / chrome to render.
 *
 * Also detects-and-soft-deletes any legacy `users` row that pre-ADR-022
 * seeds may have inserted for the super-admin in the synthetic platform
 * tenant — soft-delete preserves the audit history while making the row
 * invisible to listing endpoints. New seeds skip this entirely.
 */
async function seedPlatformAdmin(): Promise<void> {
  // Soft-delete any legacy `users` row from a pre-ADR-022 seed.
  const legacyUsers = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.keycloakId, ADMIN_KEYCLOAK_ID), isNull(users.deletedAt)))
    .limit(1);
  if (legacyUsers.length > 0) {
    await systemDb
      .update(users)
      .set({ deletedAt: new Date(), keycloakId: null })
      .where(eq(users.keycloakId, ADMIN_KEYCLOAK_ID));
    console.warn(
      `[seed] Soft-deleted legacy admin user row (keycloakId=${ADMIN_KEYCLOAK_ID}) — ADR-022 moves super-admins to platform_admins.`,
    );
  }

  const [existing] = await systemDb
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(
      and(eq(platformAdmins.keycloakId, ADMIN_KEYCLOAK_ID), isNull(platformAdmins.deletedAt)),
    )
    .limit(1);
  if (existing) {
    console.log(`[seed] Platform admin already present (keycloakId=${ADMIN_KEYCLOAK_ID})`);
    return;
  }

  await systemDb.insert(platformAdmins).values({
    email: ADMIN_EMAIL,
    firstName: ADMIN_FIRST_NAME,
    lastName: ADMIN_LAST_NAME,
    keycloakId: ADMIN_KEYCLOAK_ID,
  });
  console.log(`[seed] Inserted platform admin ${ADMIN_EMAIL}`);
}

/**
 * Seed the secondary "Demo Workspace" tenant (`…b1`) with three pre-seeded
 * users (org_admin / user / viewer) plus a fresh batch of realistic data
 * (constituents / campaigns / donations).
 *
 * Originally this tenant was an *empty* impersonation playground, but the
 * empty shell made it useless for picker / list / dashboard testing — an
 * operator switching into it saw nothing actionable. Seeding the same data
 * shape as the Demo NPO gives camille / leo / inès a real working surface
 * while still keeping the keycloak ids and roles disjoint from the NPO
 * tenant for clean impersonation matrix coverage.
 *
 * Tenant + user creation is idempotent (skip-on-existing). The data step is
 * gated by the caller (`main` runs the data seed only when `c1` is empty,
 * which is the same fresh-DB signal that the dev-up.sh wrapper checks).
 */
async function seedDemoTenant(options: { seedData: boolean }): Promise<void> {
  const [existing] = await db.select().from(tenants).where(eq(tenants.id, DEMO_TENANT_ID));
  if (!existing) {
    await db.insert(tenants).values({
      id: DEMO_TENANT_ID,
      name: DEMO_TENANT_NAME,
      slug: DEMO_TENANT_SLUG,
      plan: "starter",
      status: "active",
    });
    console.log(`[seed] Created demo tenant ${DEMO_TENANT_SLUG} (${DEMO_TENANT_ID})`);
  } else {
    console.log(`[seed] Reusing demo tenant ${DEMO_TENANT_SLUG} (${DEMO_TENANT_ID})`);
  }

  for (const u of DEMO_USERS) {
    const [present] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, u.email))
      .limit(1);
    if (present) {
      console.log(`[seed] Demo user ${u.email} already present`);
      continue;
    }
    await withTenantContext(DEMO_TENANT_ID, async (tx) => {
      try {
        await tx.insert(users).values({
          orgId: DEMO_TENANT_ID,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
          keycloakId: u.keycloakId,
        });
        console.log(`[seed] Inserted demo user ${u.email} (${u.role})`);
      } catch {
        console.warn(`[seed] Skipped demo user ${u.email}: already exists or constraint violation`);
      }
    });
  }

  if (options.seedData) {
    await seedOrgData(DEMO_TENANT_ID, "demo-workspace");
  } else {
    console.log("[seed] Skipping demo workspace data — fixture tenant already populated.");
  }
}

/**
 * Seed a small fixture of past impersonation sessions so the Back
 * Office list at `/admin/impersonation` is non-empty on a fresh dev
 * environment (issue #428). Without this, the Replicate button has
 * nothing to act on the first time a staff engineer logs in, which
 * defeats the whole point of "dev-speed for support work."
 *
 * Targets are the seeded `users` rows from both tenants (NPO: alice
 * c2 + bob c3; Demo Workspace: camille b1 + léo b2 + inès b3).
 * Impersonator is the seeded super-admin (ADMIN_KEYCLOAK_ID). Modes,
 * end_reasons, and time ranges are mixed so the list exercises every
 * `deriveStatus` branch in the page (`active` excluded — these are
 * all historical) and both mode-badge variants.
 *
 * Idempotent at the "any rows present for this operator" level — if
 * a previous seed run already inserted history, skip without
 * appending. This matches the conservative pattern the data tables
 * use (the dev-up.sh wrapper gates re-runs on `constituents = 0`).
 */
async function seedImpersonationHistory(): Promise<void> {
  const existing = await systemDb
    .select({ id: impersonationSessions.id })
    .from(impersonationSessions)
    .where(eq(impersonationSessions.impersonatorKeycloakId, ADMIN_KEYCLOAK_ID))
    .limit(1);
  if (existing.length > 0) {
    console.log(
      `[seed] Impersonation history already present (operator=${ADMIN_KEYCLOAK_ID}) — skipping`,
    );
    return;
  }

  // Pull the seeded targets (NPO alice/bob + Demo camille/léo/inès) by
  // keycloak_id so the fixture stays in lockstep with the user seed.
  // A missing target (e.g. the realm seed changed) means we just have
  // fewer past sessions — not a hard failure.
  const NPO_ALICE = "00000000-0000-0000-0000-0000000000c2";
  const NPO_BOB = "00000000-0000-0000-0000-0000000000c3";
  const DEMO_CAMILLE = DEMO_USERS[0].keycloakId;
  const DEMO_LEO = DEMO_USERS[1].keycloakId;
  const DEMO_INES = DEMO_USERS[2].keycloakId;

  type Fixture = {
    targetKeycloakId: string;
    targetOrgId: string;
    targetRole: string;
    mode: "delegation" | "impersonation";
    reason: string;
    /** Hours ago the session started. */
    startedHoursAgo: number;
    /** TTL (seconds) — fed to expires_at = started_at + ttl. */
    ttlSeconds: number;
    /**
     * One of:
     *   - "manual"   — operator clicked End-Session normally
     *   - "revoked"  — another super-admin force-ended the session
     *   - "switched" — operator switched to a different session
     *   - "expired"  — session timed out (ended_at IS NULL, expires_at < now)
     *   - "active-expired-explicit" — same TTL outcome but with ended_at
     *     written (operator hit End after the TTL passed; rare but happens)
     */
    outcome: "manual" | "revoked" | "switched" | "expired" | "active-expired-explicit";
  };

  // Reasons are intentionally NPO-shaped and ≥ 20 chars (the validator
  // floor). The mix exercises both modes and every derived status, with
  // a slight lean toward "manual" + "delegation" because that's the
  // realistic dominant case for a working support team.
  const fixtures: Fixture[] = [
    {
      targetKeycloakId: NPO_ALICE,
      targetOrgId: TENANT_ID,
      targetRole: "org_admin",
      mode: "delegation",
      reason:
        "Setting up the new fund routing on behalf of Alice — she's on PTO and the year-end appeal launches Monday.",
      startedHoursAgo: 4,
      ttlSeconds: 60 * 60,
      outcome: "manual",
    },
    {
      targetKeycloakId: NPO_BOB,
      targetOrgId: TENANT_ID,
      targetRole: "user",
      mode: "impersonation",
      reason:
        "Reproducing the donor-receipt PDF rendering issue Bob reported in ticket #5872 — only repros under his account.",
      startedHoursAgo: 26,
      ttlSeconds: 60 * 60,
      outcome: "expired",
    },
    {
      targetKeycloakId: NPO_ALICE,
      targetOrgId: TENANT_ID,
      targetRole: "org_admin",
      mode: "delegation",
      reason:
        "Configuring Mollie test keys with Alice during the onboarding call — handed back to her once webhook verified.",
      startedHoursAgo: 50,
      ttlSeconds: 60 * 60,
      outcome: "manual",
    },
    {
      targetKeycloakId: DEMO_CAMILLE,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "org_admin",
      mode: "delegation",
      reason:
        "Walking Camille through the postal-export preview during the demo workspace orientation session.",
      startedHoursAgo: 72,
      ttlSeconds: 60 * 60,
      outcome: "manual",
    },
    {
      targetKeycloakId: DEMO_LEO,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "user",
      mode: "impersonation",
      reason:
        "Investigating why Léo's constituents list pagination shows zero rows after the bulk-import dry-run.",
      startedHoursAgo: 96,
      ttlSeconds: 60 * 60,
      outcome: "switched",
    },
    {
      targetKeycloakId: DEMO_INES,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "viewer",
      mode: "impersonation",
      reason:
        "Verifying the viewer role really cannot trigger the export — Inès saw a button she shouldn't have access to.",
      startedHoursAgo: 120,
      ttlSeconds: 30 * 60,
      outcome: "manual",
    },
    {
      targetKeycloakId: NPO_BOB,
      targetOrgId: TENANT_ID,
      targetRole: "user",
      mode: "delegation",
      reason:
        "Emergency revocation drill — another staffer revoked this session as part of the quarterly incident-response rehearsal.",
      startedHoursAgo: 168,
      ttlSeconds: 4 * 60 * 60,
      outcome: "revoked",
    },
    {
      targetKeycloakId: DEMO_CAMILLE,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "org_admin",
      mode: "delegation",
      reason:
        "First-time CSM walkthrough of the campaign editor with Camille — covered draft, preview, publish, archive.",
      startedHoursAgo: 240,
      ttlSeconds: 4 * 60 * 60,
      outcome: "active-expired-explicit",
    },
    {
      targetKeycloakId: DEMO_LEO,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "user",
      mode: "impersonation",
      reason:
        "Reproducing a Drizzle 0.45 error-shape regression Léo hit — pre-fix, pure read-only checking of the donation form.",
      startedHoursAgo: 480,
      ttlSeconds: 60 * 60,
      outcome: "expired",
    },
  ];

  const now = Date.now();
  for (const f of fixtures) {
    const createdAt = new Date(now - f.startedHoursAgo * 3600_000);
    const expiresAt = new Date(createdAt.getTime() + f.ttlSeconds * 1000);
    const endedAt =
      f.outcome === "expired"
        ? null
        : f.outcome === "active-expired-explicit"
          ? expiresAt
          : // For manual / revoked / switched, end the session a bit before
            // the natural expiry so the row shows a real "ended" timestamp
            // distinct from `expires_at`.
            new Date(
              createdAt.getTime() + Math.floor(f.ttlSeconds * 0.4) * 1000,
            );
    const endReason: "manual" | "revoked" | "expired" | "switched" | null =
      f.outcome === "expired"
        ? null
        : f.outcome === "active-expired-explicit"
          ? "expired"
          : f.outcome;

    // INSERT through systemDb (BYPASSRLS) — impersonation_sessions is
    // a platform table with no tenant context. Use raw SQL so we can
    // pin created_at to a historical timestamp (the Drizzle insert
    // builder treats it as defaulted).
    await systemDb.execute(sql`
      INSERT INTO impersonation_sessions (
        impersonator_keycloak_id,
        target_keycloak_id,
        target_org_id,
        target_role,
        mode,
        reason,
        expires_at,
        ended_at,
        end_reason,
        ip_hash,
        user_agent,
        created_at
      ) VALUES (
        ${ADMIN_KEYCLOAK_ID},
        ${f.targetKeycloakId},
        ${f.targetOrgId},
        ${f.targetRole},
        ${f.mode}::impersonation_mode,
        ${f.reason},
        ${expiresAt.toISOString()},
        ${endedAt ? endedAt.toISOString() : null},
        ${endReason ? sql`${endReason}::impersonation_end_reason` : sql`NULL`},
        ${"5eed5eed5eed5eed"},
        ${"givernance-seed/1.0 (impersonation history fixture)"},
        ${createdAt.toISOString()}
      )
    `);
  }
  console.log(
    `[seed] Inserted ${fixtures.length} historical impersonation sessions for operator=${ADMIN_KEYCLOAK_ID}`,
  );
}

async function main() {
  console.log("[seed] Starting Givernance dev seed…");
  await ensurePlatformSentinelTenant();
  const orgId = await findOrCreateTenant();
  await seedPlatformAdmin();
  await seedOrgData(orgId, "demo-npo");
  await seedNpoUsers(orgId);
  // Demo workspace tenant gets the same data shape as the NPO tenant so
  // the picker / dashboards / lists are non-empty when the operator
  // switches into it. The shell-level gate in `dev-up.sh` is the only
  // re-run guard — once it triggers a seed run, both tenants are
  // populated together so they stay in lockstep.
  await seedDemoTenant({ seedData: true });
  // Past sessions fixture so the Back Office list isn't empty on a
  // fresh dev env (issue #428). Idempotent — skips if the seeded
  // super-admin already has any session rows.
  await seedImpersonationHistory();
  console.log("[seed] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
