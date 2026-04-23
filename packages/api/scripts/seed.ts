/**
 * Development database seed — populates the `givernance` tenant with
 * realistic but fake constituents, campaigns, and donations so the
 * frontend (issue #41, PR-B2) has data to render.
 *
 * Run with:
 *   pnpm --filter @givernance/api run db:seed
 *
 * Tenant invariant: the row with id = TENANT_ID is the authoritative
 * "givernance" tenant. This matches the seeded Keycloak user's `org_id`
 * attribute (see `infra/keycloak/realm-givernance.json`). If a pre-existing
 * tenant holds the slug under a different id (e.g. created via the signup
 * flow), its slug is renamed to free the fixture slot rather than reused —
 * this prevents Keycloak/DB id drift that otherwise yields 404s on
 * tenant-scoped admin routes. Constituents/campaigns/donations are
 * inserted fresh on every run. Intended for local dev only — never run
 * against production.
 */

import { campaigns, constituents, donations, tenants } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import { db, withTenantContext } from "../src/lib/db.js";

const TENANT_SLUG = "givernance";
const TENANT_NAME = "Givernance Demo NPO";
/** Fixed UUID referenced by the seeded Keycloak user's `org_id` attribute. */
const TENANT_ID = "00000000-0000-0000-0000-0000000000a1";
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
  // The seeded Keycloak user's `org_id` attribute points at TENANT_ID
  // (see infra/keycloak/realm-givernance.json). Lookup must be by id, not
  // by slug, so signup-created tenants sharing the slug don't win the lookup
  // and leave the Keycloak user orphaned.
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

async function main() {
  console.log("[seed] Starting Givernance dev seed…");
  const orgId = await findOrCreateTenant();
  await seedOrgData(orgId);
  console.log("[seed] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
