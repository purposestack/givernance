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
  platformAdmins,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
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
 * Best-effort cleanup of the legacy `…a1` synthetic platform tenant that
 * pre-ADR-022 seeds created. If a developer pulls this branch with their
 * existing `pnpm db:seed` state, the old row will still be present —
 * archive it (ADR cascading) so it's invisible to listing endpoints
 * without touching its history. New seeds skip this entirely.
 */
async function archiveLegacyPlatformTenant(): Promise<void> {
  const LEGACY_PLATFORM_TENANT_ID = "00000000-0000-0000-0000-0000000000a1";
  const [legacy] = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, LEGACY_PLATFORM_TENANT_ID));
  if (!legacy) return;
  if (legacy.status === "archived") {
    console.log(
      `[seed] Legacy platform tenant ${LEGACY_PLATFORM_TENANT_ID} already archived — skipping`,
    );
    return;
  }
  await db
    .update(tenants)
    .set({ status: "archived" })
    .where(eq(tenants.id, LEGACY_PLATFORM_TENANT_ID));
  console.warn(
    `[seed] Archived legacy platform tenant ${LEGACY_PLATFORM_TENANT_ID} (ADR-022). It remains in the DB for history but is invisible to listing endpoints.`,
  );
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

  return {
    firstName,
    lastName,
    email: Math.random() > 0.1 ? emailFromName(firstName, lastName, index) : null,
    phone: Math.random() > 0.3 ? `06 ${randomInt(10, 99)} ${randomInt(10, 99)} ${randomInt(10, 99)} ${randomInt(10, 99)}` : null,
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

async function seedOrgData(orgId: string) {
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
    console.log(`[seed] Inserted ${insertedConstituents.length} constituents`);

    // Campaigns
    const campaignRows = Array.from({ length: CAMPAIGN_COUNT }, (_, i) => ({
      ...buildCampaign(i),
      orgId,
    }));
    const insertedCampaigns = await tx
      .insert(campaigns)
      .values(campaignRows)
      .returning({ id: campaigns.id });
    console.log(`[seed] Inserted ${insertedCampaigns.length} campaigns`);

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
        paymentRef: `SEED-${Date.now()}-${i.toString().padStart(4, "0")}`,
        donatedAt,
        fiscalYear: donatedAt.getFullYear(),
      };
    });
    const insertedDonations = await tx
      .insert(donations)
      .values(donationRows)
      .returning({ id: donations.id });
    console.log(`[seed] Inserted ${insertedDonations.length} donations`);
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
 * Seed the impersonation-playground tenant + 3 users in distinct roles.
 * Idempotent: skips when the tenant or users already exist.
 */
async function seedDemoTenant(): Promise<void> {
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
      .where(eq(users.keycloakId, u.keycloakId))
      .limit(1);
    if (present) continue;
    await withTenantContext(DEMO_TENANT_ID, async (tx) => {
      await tx.insert(users).values({
        orgId: DEMO_TENANT_ID,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        keycloakId: u.keycloakId,
      });
    });
    console.log(`[seed] Inserted demo user ${u.email} (${u.role})`);
  }
}

async function main() {
  console.log("[seed] Starting Givernance dev seed…");
  await archiveLegacyPlatformTenant();
  const orgId = await findOrCreateTenant();
  await seedPlatformAdmin();
  await seedOrgData(orgId);
  await seedDemoTenant();
  console.log("[seed] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
