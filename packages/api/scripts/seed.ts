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
  pledges,
  platformAdmins,
  surveyInvitations,
  surveyResponses,
  surveys,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
const CONSTITUENT_COUNT = 200; // (#447) was 50 — bump for a credible-sized NPO
const CAMPAIGN_COUNT = 15; // (#447) was 5 — mix active / closed / draft
const DONATION_COUNT = 2500; // (#447) was 100 — 24 months of history for the volume timeline + period deltas

/**
 * Demo posture for the super-admin finance dashboard (epic #434).
 *
 * Each demo tenant needs to land an A+ / A grade on the Mobilisation
 * Score so prospects + investors visiting the dashboard see a healthy
 * platform, not a struggling one. The grade is 25% Activation +
 * 25% Récurrence + 20% Échelle + 20% Croissance + 10% Diversité; to
 * hit ≥ 90 (A+) we need ALL five components ≥ 80.
 *
 * Knobs (`seedOrgData` below applies these in addition to the historical
 * DONATION_COUNT spread):
 *  - DEMO_RECENT_DONATIONS — donations placed in the last 30 days
 *    (drives Activation + Échelle and gives the volume timeline its
 *    rich curve, no empty week).
 *  - DEMO_PREVIOUS_DONATIONS — donations placed in the 30 days BEFORE
 *    that — sized so `recent / previous > 1.10` to land Croissance ≥ 80.
 *  - DEMO_PLEDGE_COUNT — active monthly + yearly pledges so Récurrence
 *    contributes a real share of revenue (otherwise it's 0 and pulls
 *    the whole grade down to ~C).
 *  - Mixed `paymentSource` across stripe / camt053 / manual so the HHI
 *    on payment_source stays low and Diversité ≥ 80.
 *
 * Keep these inflated for demo; if a prospect wants "realistic" numbers
 * they can flip a flag, but the default for `db:seed:local` is "looks
 * great on stage".
 */
// Demo posture targets A+ (Mobilisation score ≥ 90). Each component
// has to clear ~90 after weighting; max theoretical is 96.7 because
// Diversité caps at ~67 with the 3-value `payment_source` enum
// (stripe / camt053 / manual; HHI floor 1/3 → 1-HHI ≈ 0.667).
//
// To hit Récurrence ≥ 95 the active MRR must approach the period's
// cleared volume. We size pledges aggressively (€1000-€5000/mo, ~all
// constituents pledging) so MRR ≈ volume; ratio clamps to 1 → 100.
// To hit Croissance ≥ 95 the recent 30d volume must be ≥ 2× the
// previous 30d (ratio +100% → clamps to 1 → 100).
const DEMO_RECENT_DONATIONS = 220;
const DEMO_PREVIOUS_DONATIONS = 90; // ≈ 40% of recent → recent / previous ≈ 2.4× → Croissance 100
const DEMO_RECENT_AMOUNT_MIN_CENTS = 10_000; // €100
const DEMO_RECENT_AMOUNT_MAX_CENTS = 120_000; // €1200 → avg €650 × 220 ≈ €143k period volume → Échelle 100
const DEMO_PREVIOUS_AMOUNT_MIN_CENTS = 5_000; // €50
const DEMO_PREVIOUS_AMOUNT_MAX_CENTS = 80_000; // €800
const DEMO_PLEDGE_COUNT = 50; // ≈ 1 per constituent → premium-recurring demo
const DEMO_PLEDGE_MONTHLY_MIN_CENTS = 100_000; // €1000/mo
const DEMO_PLEDGE_MONTHLY_MAX_CENTS = 500_000; // €5000/mo → avg €3000/mo per monthly pledge
const DEMO_PLEDGE_YEARLY_MIN_CENTS = 1_200_000; // €12k/yr → €1000/mo equiv
const DEMO_PLEDGE_YEARLY_MAX_CENTS = 6_000_000; // €60k/yr → €5000/mo equiv
const DEMO_PAYMENT_SOURCE_MIX: Array<"stripe" | "camt053" | "manual"> = [
  // Roughly 55/30/15 — a healthy small-NPO mix where Stripe leads but
  // SEPA-bank + manual offline gifts both contribute meaningfully.
  ...Array(11).fill("stripe"),
  ...Array(6).fill("camt053"),
  ...Array(3).fill("manual"),
];

/**
 * Currency mix for the 24-month historical batch — drives the
 * super-admin "Devises" donut on the platform finance dashboard.
 * Heavy EUR (the NPO base currency) with a small GBP + CHF tail
 * so the donut shows three slices rather than 100% EUR. Recent
 * donations stay EUR-only to keep the Croissance + Récurrence
 * math clean (no FX-snapshot edge cases needed for demo).
 */
const DEMO_CURRENCY_MIX: Array<{ currency: "EUR" | "GBP" | "CHF"; rate: number; weight: number }> =
  [
    { currency: "EUR", rate: 1, weight: 85 },
    { currency: "GBP", rate: 1.15, weight: 10 },
    { currency: "CHF", rate: 1.05, weight: 5 },
  ];

/**
 * Monthly seasonality multiplier for historical donations (#447). Indexed
 * 0..11 (Jan..Dec). Models real-NPO fundraising patterns: post-holiday
 * lull Jan/Feb, summer dip, GivingTuesday + year-end spike Nov/Dec.
 */
const SEASONALITY_BY_MONTH = [
  0.7, // Jan — post-holiday lull
  0.7, // Feb
  1.0, // Mar
  1.0, // Apr
  1.1, // May — spring campaigns
  0.9, // Jun
  0.7, // Jul — summer dip
  0.6, // Aug
  1.0, // Sep — rentrée
  1.1, // Oct
  1.5, // Nov — GivingTuesday
  2.0, // Dec — year-end peak
];

const HISTORICAL_MONTHS_BACK = 24;

/**
 * Pick a calendar month bucket using SEASONALITY_BY_MONTH weights, looking
 * back N months from today. Returns a Date roughly in the middle of that
 * bucket; the caller adds per-day jitter.
 */
function pickSeasonalMonthOffset(monthsBack: number): number {
  // Build a weighted CDF over [0..monthsBack-1] (0 = current month, growing back).
  const now = new Date();
  const weights: number[] = [];
  for (let i = 0; i < monthsBack; i++) {
    const targetMonth = (now.getMonth() - i + 1200) % 12;
    weights.push(SEASONALITY_BY_MONTH[targetMonth] ?? 1);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return i;
  }
  return 0;
}

function dateInMonthOffset(monthsBack: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack);
  // Random day of month + jitter
  d.setDate(randomInt(1, 28));
  d.setHours(randomInt(8, 22), randomInt(0, 59), randomInt(0, 59), 0);
  return d;
}

function pickCurrency(): { currency: "EUR" | "GBP" | "CHF"; rate: number } {
  const total = DEMO_CURRENCY_MIX.reduce((a, c) => a + c.weight, 0);
  let r = Math.random() * total;
  for (const c of DEMO_CURRENCY_MIX) {
    r -= c.weight;
    if (r <= 0) return { currency: c.currency, rate: c.rate };
  }
  return { currency: "EUR", rate: 1 };
}

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

// Weighted pool for the PRIMARY type (donor-heavy, mirrors a real NPO base).
const PRIMARY_TYPE_POOL: ConstituentType[] = [
  "donor",
  "donor",
  "donor",
  "volunteer",
  "member",
  "partner",
];
// Full distinct value set — used to pick a guaranteed-different SECOND type so
// the multi-type seed is reliable (and surfaces `beneficiary`, which is absent
// from the weighted primary pool).
const ALL_CONSTITUENT_TYPES: ConstituentType[] = [
  "donor",
  "volunteer",
  "member",
  "beneficiary",
  "partner",
];

function buildConstituent(index: number) {
  const isOrganization = index % 5 === 0;
  const primary: ConstituentType = isOrganization ? "partner" : randomPick(PRIMARY_TYPE_POOL);
  // Issue #465 — give ~30% of individuals a genuine second type (e.g. a donor
  // who also volunteers) so the multi-badge UI has realistic demo data. The
  // second value is drawn from the set EXCLUDING the primary, so the branch
  // always yields two distinct types rather than silently collapsing.
  const types: ConstituentType[] = [primary];
  if (!isOrganization && Math.random() > 0.7) {
    const candidates = ALL_CONSTITUENT_TYPES.filter((t) => t !== primary);
    types.push(randomPick(candidates));
  }

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
    // `type` (singular) is the back-compat shadow = `types[0]` (issue #465).
    type: types[0],
    types,
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
    // Safety gate (PR #441 follow-up): if the demo tenant already has
    // donations, SKIP the seed entirely rather than destroying data.
    //
    // Why: staging runs `db:seed` automatically on every Kamal deploy.
    // The first version of this function wiped pledges + donations +
    // campaigns + constituents unconditionally — destroying any manual
    // test data operators created via the UI / API on the demo tenant
    // between deploys. The filter-by-SEED-* approach also failed because
    // it left non-seed donations referencing constituents we tried to
    // delete (donations_constituent_id_fkey violation, FAILED deploy).
    //
    // Operator can force a refresh by setting SEED_DESTRUCTIVE_WIPE=true:
    //   ssh givernance-staging
    //   docker exec -e SEED_DESTRUCTIVE_WIPE=true <api> pnpm db:seed
    // …or simply running TRUNCATE on the demo tenant's tables.
    const destructiveWipe = process.env.SEED_DESTRUCTIVE_WIPE === "true";

    const [existingDonation] = await tx
      .select({ id: donations.id })
      .from(donations)
      .where(eq(donations.orgId, orgId))
      .limit(1);

    if (existingDonation && !destructiveWipe) {
      console.log(
        `[seed][${tenantLabel}] Demo tenant already has donations — SKIPPING seed (set SEED_DESTRUCTIVE_WIPE=true to refresh)`,
      );
      return;
    }

    if (existingDonation && destructiveWipe) {
      // Destructive refresh requested — wipe in FK order.
      //   pledges → cascades pledge_installments
      //   donations → pledge_installments.donation_id is ON DELETE SET NULL
      //   campaigns → no inbound FKs from this set
      //   constituents → safe now that donations + pledges are gone
      await tx.delete(pledges).where(eq(pledges.orgId, orgId));
      await tx.delete(donations).where(eq(donations.orgId, orgId));
      await tx.delete(campaigns).where(eq(campaigns.orgId, orgId));
      await tx.delete(constituents).where(eq(constituents.orgId, orgId));
      console.log(
        `[seed][${tenantLabel}] SEED_DESTRUCTIVE_WIPE=true — wiped existing demo data`,
      );
    }

    // Constituents — spread `createdAt` over HISTORICAL_MONTHS_BACK (24 mo)
    // so the org dashboard's "new donors this month" KPI has a credible
    // history + a non-zero current period. Last ~10% of the cohort land
    // in the last 30 days for the "+N this month" trend chip.
    const constituentRows = Array.from({ length: CONSTITUENT_COUNT }, (_, i) => {
      const isRecent = i < Math.floor(CONSTITUENT_COUNT * 0.1); // 20 / 200 in last 30d
      const createdAt = isRecent
        ? new Date(Date.now() - randomInt(0, 29) * 24 * 3600_000)
        : dateInMonthOffset(randomInt(1, HISTORICAL_MONTHS_BACK - 1));
      return {
        ...buildConstituent(i),
        orgId,
        createdAt,
        updatedAt: createdAt,
      };
    });
    const insertedConstituents = await tx
      .insert(constituents)
      .values(constituentRows)
      .returning({ id: constituents.id });
    console.log(`[seed][${tenantLabel}] Inserted ${insertedConstituents.length} constituents`);

    // Campaigns — 15 total spread over 24 months, ~33% active /
    // ~53% closed / ~14% draft. Two of the actives are created in
    // the last 30 days so the org dashboard's "new active campaigns
    // this month" trend chip is positive.
    const campaignRows = Array.from({ length: CAMPAIGN_COUNT }, (_, i) => {
      // Distribute statuses: index 0-4 = active (5), 5-12 = closed (8), 13-14 = draft (2).
      const status: CampaignStatus = i < 5 ? "active" : i < 13 ? "closed" : "draft";
      // Two of the actives in the last 30 days for the trend KPI.
      const createdAt =
        status === "active" && i < 2
          ? new Date(Date.now() - randomInt(0, 28) * 24 * 3600_000)
          : dateInMonthOffset(randomInt(1, HISTORICAL_MONTHS_BACK - 1));
      const base = buildCampaign(i);
      return {
        ...base,
        status,
        orgId,
        createdAt,
        updatedAt: createdAt,
      };
    });
    const insertedCampaigns = await tx
      .insert(campaigns)
      .values(campaignRows)
      .returning({ id: campaigns.id, status: campaigns.status });
    const activeCampaignIds = insertedCampaigns
      .filter((c) => c.status === "active")
      .map((c) => c.id);
    console.log(
      `[seed][${tenantLabel}] Inserted ${insertedCampaigns.length} campaigns (${activeCampaignIds.length} active)`,
    );

    // Donations — link each to a random constituent + ~80% to a campaign.
    // Three batches (see DEMO_* constants above for the rationale):
    //  1. "Historical spread" — the original DONATION_COUNT random-dates-
    //     across-last-year batch (kept for backwards compat with screens
    //     that look at long-tail history).
    //  2. "Last 30d" — recent activity that drives the dashboard's
    //     period=30d KPIs + Activation + Échelle.
    //  3. "Previous 30d" — the period BEFORE the recent batch, sized so
    //     Croissance lands positive (recent > previous by ~20%).
    const paymentMethods = ["card", "sepa", "check", "cash", "bank_transfer"];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // ~0.7% of donations are flipped to status='refunded' with a
    // realistic refunded_at (between donated_at and donated_at + 30 days)
    // so the dashboard's "Taux de remboursement" gauge has data. 0.7%
    // sits comfortably in the gauge's green zone (sain < 1% · alerte
    // > 5%) — visible cursor on the bar, no false alarm.
    const REFUND_RATE = 0.007;

    const buildDonation = (
      i: number,
      donatedAt: Date,
      batch: "hist" | "recent" | "prev",
      amountRange: [number, number],
      currencyOverride?: "EUR" | "GBP" | "CHF",
      rateOverride?: number,
    ) => {
      const constituent = randomPick(insertedConstituents);
      const campaign = Math.random() > 0.2 ? randomPick(insertedCampaigns) : null;
      const amountCents = randomInt(amountRange[0], amountRange[1]);
      const paymentSource = randomPick(DEMO_PAYMENT_SOURCE_MIX);
      const currency = currencyOverride ?? "EUR";
      const rate = rateOverride ?? 1;
      const amountBaseCents = Math.round(amountCents * rate);
      // Take-rate snapshot — Givernance keeps 1.5% + 0.30€ per cleared
      // donation. Pre-computing the cents fields here means the dashboard
      // KPIs (Revenu Givernance, take-rate) light up immediately on
      // first dashboard render rather than waiting on a worker pass.
      const platformFeeCents = Math.max(30, Math.round(amountCents * 0.015) + 30);
      const platformFeeBaseCents = Math.round(platformFeeCents * rate);
      // Refund timing: a refund-delay of 1-30 days after donation; if
      // that would land in the future (recent donations + delay), clamp
      // refunded_at to a short recent past so the dashboard's 30d
      // refund-rate KPI actually surfaces a non-zero rate. Earlier
      // version generated future refunded_at dates — visible row in
      // the DB, but filtered out by `donated_at >= NOW() - 30d AND
      // refunded_at IS NOT NULL` → KPI stayed at 0%.
      const isRefunded = Math.random() < REFUND_RATE;
      const nowMs = Date.now();
      const proposedRefundMs = donatedAt.getTime() + randomInt(1, 30) * 24 * 3600_000;
      const refundedAt = isRefunded
        ? new Date(
            proposedRefundMs > nowMs
              ? nowMs - randomInt(0, 7) * 24 * 3600_000 // clamp future → recent past
              : proposedRefundMs,
          )
        : null;
      return {
        orgId,
        constituentId: constituent.id,
        amountCents,
        currency,
        exchangeRate: String(rate),
        amountBaseCents,
        platformFeeCents,
        platformFeeBaseCents,
        // Stripe fee approx 1.4% + 0.25€ for EU cards (only on stripe rail).
        stripeFeeCents:
          paymentSource === "stripe"
            ? Math.round(Math.max(25, Math.round(amountCents * 0.014) + 25) * rate)
            : null,
        paymentSource,
        campaignId: campaign?.id ?? null,
        paymentMethod: randomPick(paymentMethods),
        paymentRef: `SEED-${tenantLabel}-${batch}-${Date.now()}-${i.toString().padStart(4, "0")}`,
        donatedAt,
        fiscalYear: donatedAt.getFullYear(),
        status: (isRefunded ? "refunded" : "cleared") as "refunded" | "cleared",
        refundedAt,
      };
    };

    // Historical 24-month batch — drives the volume timeline + period-
    // over-period comparisons on both dashboards. Each donation's month
    // is picked according to SEASONALITY_BY_MONTH so the chart shows the
    // real NPO pattern (Dec/Nov peak, Jan/Feb lull, summer dip).
    // Currency mix 85/10/5 EUR/GBP/CHF so the "Devises" donut on the
    // super-admin dashboard has 3 slices.
    const historicalRows = Array.from({ length: DONATION_COUNT }, (_, i) => {
      // Pick a month bucket weighted by seasonality, then a random day.
      // Skip the last THREE months (0, 1, 2) entirely — those windows
      // are driven by the `recent` + `previous` batches below. Without
      // this gap the historical bulk leaks into the period & previous-
      // period windows and tanks the Croissance KPI (verified locally —
      // an earlier draft with monthsBack >= 1 dropped the dashboard
      // grade from A+ to B 66 because historical's December peak landed
      // in the previous-30d window depending on calendar position).
      const monthsBack = Math.max(3, pickSeasonalMonthOffset(HISTORICAL_MONTHS_BACK));
      const donatedAt = dateInMonthOffset(monthsBack);
      const { currency, rate } = pickCurrency();
      return buildDonation(i, donatedAt, "hist", [500, 500_000], currency, rate);
    });
    const recentRows = Array.from({ length: DEMO_RECENT_DONATIONS }, (_, i) => {
      // Spread across the last 30 days, slight peak in the most recent
      // 14 days so the volume chart has a natural rising curve. Currency
      // mix carried through so the dashboard's "Devises" donut shows
      // 3 slices (EUR-dominated, GBP + CHF tails) on the default 30d
      // period rather than 100% EUR.
      const daysAgo = Math.floor(Math.random() ** 1.5 * 30);
      const donatedAt = new Date(now - daysAgo * dayMs);
      const { currency, rate } = pickCurrency();
      return buildDonation(
        i,
        donatedAt,
        "recent",
        [DEMO_RECENT_AMOUNT_MIN_CENTS, DEMO_RECENT_AMOUNT_MAX_CENTS],
        currency,
        rate,
      );
    });
    const previousRows = Array.from({ length: DEMO_PREVIOUS_DONATIONS }, (_, i) => {
      const daysAgo = 30 + Math.floor(Math.random() * 30);
      const donatedAt = new Date(now - daysAgo * dayMs);
      const { currency, rate } = pickCurrency();
      return buildDonation(
        i,
        donatedAt,
        "prev",
        [DEMO_PREVIOUS_AMOUNT_MIN_CENTS, DEMO_PREVIOUS_AMOUNT_MAX_CENTS],
        currency,
        rate,
      );
    });

    const donationRows = [...historicalRows, ...recentRows, ...previousRows];
    const insertedDonations = await tx
      .insert(donations)
      .values(donationRows)
      .returning({ id: donations.id });
    console.log(
      `[seed][${tenantLabel}] Inserted ${insertedDonations.length} donations (${DONATION_COUNT} historical + ${DEMO_RECENT_DONATIONS} last-30d + ${DEMO_PREVIOUS_DONATIONS} previous-30d)`,
    );

    // Active pledges — drives the Récurrence component of the Mobilisation
    // Score and the "Revenu récurrent" KPI tile.
    const pledgeRows = Array.from({ length: DEMO_PLEDGE_COUNT }, () => {
      const constituent = randomPick(insertedConstituents);
      const frequency = Math.random() < 0.75 ? "monthly" : "yearly";
      const amountCents =
        frequency === "monthly"
          ? randomInt(DEMO_PLEDGE_MONTHLY_MIN_CENTS, DEMO_PLEDGE_MONTHLY_MAX_CENTS)
          : randomInt(DEMO_PLEDGE_YEARLY_MIN_CENTS, DEMO_PLEDGE_YEARLY_MAX_CENTS);
      // Multi-currency pledges (#447 follow-up): same EUR/GBP/CHF mix as
      // donations so the MRR figure on the super-admin dashboard is
      // genuinely currency-diverse, and so the per-currency donut
      // reflects pledge contributions when the super-admin scopes to a
      // tenant where recurring revenue dominates. `amount_base_cents`
      // is snapshotted to the EUR equivalent at the FX rate stored in
      // `exchange_rate` — same pattern as donations.
      const { currency, rate } = pickCurrency();
      return {
        orgId,
        constituentId: constituent.id,
        amountCents,
        currency,
        exchangeRate: String(rate),
        amountBaseCents: Math.round(amountCents * rate),
        frequency: frequency as "monthly" | "yearly",
        status: "active" as const,
        paymentGateway: "stripe",
      };
    });
    const insertedPledges = await tx
      .insert(pledges)
      .values(pledgeRows)
      .returning({ id: pledges.id });
    console.log(`[seed][${tenantLabel}] Inserted ${insertedPledges.length} active pledges`);
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
    // The four fixtures below guarantee EVERY seeded user has at
    // least one session of BOTH modes (delegation + impersonation),
    // so the new Quick Filters (issue #428 follow-up) demonstrate
    // useful data for every user when narrowed by mode. Without
    // these, filtering by "Impersonation" would empty the row for
    // alice + camille; filtering by "Delegation" would empty the
    // row for léo + inès. Per-tenant / per-mode coverage matrix:
    //
    //   alice  (NPO)    delegation + impersonation
    //   bob    (NPO)    delegation + impersonation
    //   camille(Demo)   delegation + impersonation
    //   léo    (Demo)   delegation + impersonation
    //   inès   (Demo)   delegation + impersonation
    {
      targetKeycloakId: NPO_ALICE,
      targetOrgId: TENANT_ID,
      targetRole: "org_admin",
      mode: "impersonation",
      reason:
        "Reproducing Alice's report of a missing donor on the year-end appeal dashboard — read-only walkthrough.",
      startedHoursAgo: 312,
      ttlSeconds: 30 * 60,
      outcome: "expired",
    },
    {
      targetKeycloakId: DEMO_CAMILLE,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "org_admin",
      mode: "impersonation",
      reason:
        "Reproducing Camille's screenshot of the postal-export download stuck at 95% — confirmed the spinner bug.",
      startedHoursAgo: 360,
      ttlSeconds: 30 * 60,
      outcome: "manual",
    },
    {
      targetKeycloakId: DEMO_LEO,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "user",
      mode: "delegation",
      reason:
        "Helping Léo wire up the Stripe Connect onboarding link during the staging walkthrough call.",
      startedHoursAgo: 408,
      ttlSeconds: 2 * 60 * 60,
      outcome: "manual",
    },
    {
      targetKeycloakId: DEMO_INES,
      targetOrgId: DEMO_TENANT_ID,
      targetRole: "viewer",
      mode: "delegation",
      reason:
        "Onboarding Inès as the new read-only treasurer — configured her notification preferences on her behalf.",
      startedHoursAgo: 552,
      ttlSeconds: 60 * 60,
      outcome: "manual",
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

/**
 * Seed the platform-level survey infrastructure (3 surveys) + per-tenant
 * invitations + responses so the super-admin finance dashboard
 * (issue #206) renders non-empty PMF / NPS / CSAT cards in dev.
 *
 * Layout:
 *   - 3 `surveys` rows (PMF Sean Ellis · NPS · CSAT) — platform-level,
 *     written through systemDb.
 *   - ~40 PMF invitations + ~30 responses (mix of very/somewhat/not
 *     disappointed so the PMF % lands above the 40% threshold).
 *   - ~60 NPS invitations + ~45 responses (0-10 spread).
 *   - ~20 CSAT invitations + ~15 responses (1-5 ratings).
 *   - ~20 of the responses carry a `text_reviewed_at` so the DPO-review
 *     filter on the dashboard has data.
 *
 * Invitations + responses target the seeded constituents (we don't have
 * tenant-admin user rows beyond alice/bob/camille/léo/inès, and the
 * invitation `user_id` is NULL-able on GDPR erasure anyway — so we use a
 * mix of the seeded users where they exist + NULL otherwise).
 *
 * Idempotent at the slug level — re-running the seed reuses existing
 * survey rows and skips invitation insertion if the survey already has
 * any rows for the target tenant.
 */
async function seedSurveys(orgIds: string[]): Promise<void> {
  // 1) Surveys — platform-level. systemDb (BYPASSRLS) per ADR-017
  // pattern: `surveys` has no `org_id` and the migration revokes app
  // role write access.
  const surveyDefs = [
    {
      slug: "pmf-2026-q2",
      kind: "pmf",
      questionFr: "Quel serait votre ressenti si vous ne pouviez plus utiliser Givernance ?",
      questionEn: "How would you feel if you could no longer use Givernance?",
      cadenceDays: 90,
      freshnessSoonDays: 60,
      freshnessStaleDays: 90,
      responseTarget: 40,
    },
    {
      slug: "nps-2026-q2",
      kind: "nps",
      questionFr:
        "Sur une échelle de 0 à 10, quelle est la probabilité que vous recommandiez Givernance ?",
      questionEn:
        "On a scale from 0 to 10, how likely are you to recommend Givernance to a colleague?",
      cadenceDays: 90,
      freshnessSoonDays: 60,
      freshnessStaleDays: 90,
      responseTarget: 60,
    },
    {
      slug: "csat-2026-continuous",
      kind: "csat",
      questionFr: "Comment évaluez-vous votre expérience récente avec notre support ?",
      questionEn: "How would you rate your recent experience with our support team?",
      cadenceDays: null,
      freshnessSoonDays: 30,
      freshnessStaleDays: 90,
      responseTarget: 20,
    },
  ] as const;

  const surveyIds: Record<string, string> = {};
  for (const def of surveyDefs) {
    const [existing] = await systemDb
      .select({ id: surveys.id })
      .from(surveys)
      .where(eq(surveys.slug, def.slug))
      .limit(1);
    if (existing) {
      surveyIds[def.kind] = existing.id;
      console.log(`[seed][surveys] Reused ${def.kind} survey ${def.slug} (${existing.id})`);
      continue;
    }
    // Schedule the next collection slightly in the future for NPS/PMF
    // (so the "à recontacter" copy lands sensibly); CSAT is continuous.
    const nextScheduledAt =
      def.kind === "csat" ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const [inserted] = await systemDb
      .insert(surveys)
      .values({
        slug: def.slug,
        kind: def.kind,
        questionFr: def.questionFr,
        questionEn: def.questionEn,
        cadenceDays: def.cadenceDays,
        freshnessSoonDays: def.freshnessSoonDays,
        freshnessStaleDays: def.freshnessStaleDays,
        responseTarget: def.responseTarget,
        nextScheduledAt,
      })
      .returning({ id: surveys.id });
    if (!inserted) throw new Error(`Failed to insert ${def.kind} survey`);
    surveyIds[def.kind] = inserted.id;
    console.log(`[seed][surveys] Inserted ${def.kind} survey ${def.slug} (${inserted.id})`);
  }

  // 2) Per-tenant invitations + responses. Skip if any invitations exist
  // for this (survey, tenant) pair — keeps re-runs idempotent.
  for (const orgId of orgIds) {
    await seedSurveyInvitationsForTenant(orgId, surveyIds);
  }
}

async function seedSurveyInvitationsForTenant(
  orgId: string,
  surveyIds: Record<string, string>,
): Promise<void> {
  // Resolve some real user ids (NULL is acceptable per the schema's
  // GDPR-erasure pattern; using real users when present keeps the
  // dashboard's "you'd be reaching out to these admins" copy honest).
  const userRows = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.orgId, orgId))
    .limit(20);
  const userPool: (string | null)[] = userRows.map((r) => r.id);
  // Pad with NULLs so erasure scenarios are also represented.
  while (userPool.length < 20) userPool.push(null);

  const spec: Array<{
    kind: "pmf" | "nps" | "csat";
    invitationCount: number;
    responseCount: number;
    daysAgoBase: number;
    /** Builder: returns the JSONB `response` payload for the i-th response. */
    buildResponse: (i: number) => Record<string, unknown>;
  }> = [
    {
      kind: "pmf",
      invitationCount: 40,
      responseCount: 30,
      // Recent so the fresh-pip shows "à jour" (PMF threshold: < 90d = fresh).
      daysAgoBase: 25,
      buildResponse: (i: number) => {
        // The aggregate view reads `response->>'category'` (not `sentiment`)
        // for the PMF count. ~60% very_disappointed lands PMF % well above
        // the 40% Sean-Ellis threshold so the dashboard headline reads
        // "60% — au-dessus du seuil 40%".
        const category =
          i % 10 < 6
            ? "very_disappointed"
            : i % 10 < 9
              ? "somewhat_disappointed"
              : "not_disappointed";
        return { category };
      },
    },
    {
      kind: "nps",
      invitationCount: 60,
      responseCount: 45,
      daysAgoBase: 20, // fresh
      // NPS = %promoters(9-10) − %detractors(0-6). Skew toward promoters
      // so the demo lands NPS ≈ +50 (excellent).
      buildResponse: (i: number) => {
        const bucket = i % 10;
        // 50% promoters (9-10), 35% passives (7-8), 15% detractors (0-6)
        const score = bucket < 5 ? 9 + (bucket % 2) : bucket < 8 ? 7 + (bucket % 2) : (i % 7);
        return { score };
      },
    },
    {
      kind: "csat",
      invitationCount: 20,
      responseCount: 15,
      daysAgoBase: 5,
      // CSAT 1-5 — skew toward 4-5 so the headline reads 4.5+/5.
      buildResponse: (i: number) => {
        const bucket = i % 10;
        const rating = bucket < 7 ? 5 : bucket < 9 ? 4 : 3;
        return { rating };
      },
    },
  ];

  const destructiveWipe = process.env.SEED_DESTRUCTIVE_WIPE === "true";

  for (const s of spec) {
    const surveyId = surveyIds[s.kind];
    if (!surveyId) continue;

    const existingInvitations = await systemDb
      .select({ id: surveyInvitations.id })
      .from(surveyInvitations)
      .where(and(eq(surveyInvitations.surveyId, surveyId), eq(surveyInvitations.orgId, orgId)));

    // Same safety gate as seedOrgData: skip if survey data already
    // exists for this (survey, tenant) pair. Real users on staging may
    // have submitted responses via the in-app modal — auto-wiping each
    // deploy would destroy that. SEED_DESTRUCTIVE_WIPE=true forces a
    // refresh (cascades responses via invitation_id FK).
    if (existingInvitations.length > 0 && !destructiveWipe) {
      console.log(
        `[seed][surveys] ${s.kind} invitations already present for tenant ${orgId} — skipping (set SEED_DESTRUCTIVE_WIPE=true to refresh)`,
      );
      continue;
    }

    if (existingInvitations.length > 0 && destructiveWipe) {
      const invitationIds = existingInvitations.map((r) => r.id);
      await systemDb
        .delete(surveyResponses)
        .where(
          and(eq(surveyResponses.orgId, orgId), inArray(surveyResponses.invitationId, invitationIds)),
        );
      await systemDb
        .delete(surveyInvitations)
        .where(and(eq(surveyInvitations.surveyId, surveyId), eq(surveyInvitations.orgId, orgId)));
      console.log(
        `[seed][surveys] SEED_DESTRUCTIVE_WIPE=true — wiped ${existingInvitations.length} ${s.kind} invitations for tenant ${orgId}`,
      );
    }

    const now = Date.now();
    const invitedAtBase = new Date(now - s.daysAgoBase * 24 * 60 * 60 * 1000);
    const invitationRows = Array.from({ length: s.invitationCount }, (_, i) => ({
      surveyId,
      orgId,
      userId: userPool[i % userPool.length] ?? null,
      channel: i % 4 === 0 ? "in_app" : "email",
      invitedAt: new Date(invitedAtBase.getTime() + i * 60 * 60 * 1000),
      expiresAt: new Date(invitedAtBase.getTime() + (i + 30) * 24 * 60 * 60 * 1000),
      // The first `responseCount` invitations get a seeded response below, so
      // mark them opened at that response's submit time — mirroring the real
      // respond flow (survey-respond.ts sets opened_at on submit). Without
      // this, a responded invitation keeps opened_at = NULL and the in-app
      // "pending" query resurfaces it at login even though a response already
      // exists, so re-submitting 409s. Unanswered invitations stay NULL.
      openedAt: i < s.responseCount ? new Date(invitedAtBase.getTime() + i * 2 * 60 * 60 * 1000) : null,
    }));
    const insertedInvitations = await systemDb
      .insert(surveyInvitations)
      .values(invitationRows)
      .returning({ id: surveyInvitations.id });
    console.log(
      `[seed][surveys] Inserted ${insertedInvitations.length} ${s.kind} invitations for tenant ${orgId}`,
    );

    // Responses — one per invitation, up to responseCount.
    const responseRows = insertedInvitations.slice(0, s.responseCount).map((inv, i) => ({
      invitationId: inv.id,
      orgId,
      response: s.buildResponse(i),
      submittedAt: new Date(invitedAtBase.getTime() + i * 2 * 60 * 60 * 1000),
      // ~20 of the total responses across all surveys get a DPO review
      // stamp. Skews to the earlier indices so the dashboard's
      // verbatims tile has something to surface.
      textReviewedAt: i < 7 ? new Date(invitedAtBase.getTime() + (i + 1) * 24 * 60 * 60 * 1000) : null,
    }));
    if (responseRows.length > 0) {
      const insertedResponses = await systemDb
        .insert(surveyResponses)
        .values(responseRows)
        .returning({ id: surveyResponses.id });
      console.log(
        `[seed][surveys] Inserted ${insertedResponses.length} ${s.kind} responses for tenant ${orgId}`,
      );
    }
  }
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
  // Surveys (PMF / NPS / CSAT) seeded for both real tenants so the
  // super-admin finance dashboard (issue #206) renders non-empty cards.
  await seedSurveys([TENANT_ID, DEMO_TENANT_ID]);
  console.log("[seed] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
