/**
 * Local development fund seed — ensures the main `givernance` organisation
 * has two realistic funds for campaign and donation UX flows.
 *
 * Run with:
 *   pnpm --filter @givernance/api exec tsx --env-file=../../.env scripts/seed-funds.ts
 */

import { funds, tenants } from "@givernance/shared/schema";
import { and, eq, inArray } from "drizzle-orm";

import { db, withTenantContext } from "../src/lib/db.js";

const TENANT_ID = "00000000-0000-0000-0000-0000000000a1";
const TENANT_SLUG = "givernance";

const FUNDS_TO_SEED = [
  {
    name: "Fonds d'Urgence Climat",
    description:
      "Fonds restreint dédié aux réponses d'urgence, à la résilience climatique et au soutien post-catastrophe.",
    type: "restricted",
  },
  {
    name: "Fonds Éducation pour Tous",
    description:
      "Fonds non restreint utilisé pour financer les programmes d'accès à l'éducation et les besoins transverses associés.",
    type: "unrestricted",
  },
] as const;

async function resolveMainOrgId(): Promise<string> {
  const [byId] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, TENANT_ID));
  if (byId) return byId.id;

  const [bySlug] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, TENANT_SLUG));
  if (bySlug) return bySlug.id;

  throw new Error(
    `Main organisation not found. Expected tenant id=${TENANT_ID} or slug=${TENANT_SLUG}.`,
  );
}

async function main() {
  console.log("[seed-funds] Starting…");
  const orgId = await resolveMainOrgId();

  await withTenantContext(orgId, async (tx) => {
    const existing = await tx
      .select({ id: funds.id, name: funds.name })
      .from(funds)
      .where(and(eq(funds.orgId, orgId), inArray(funds.name, FUNDS_TO_SEED.map((fund) => fund.name))));

    const existingByName = new Map(existing.map((fund) => [fund.name, fund.id]));
    const missingFunds = FUNDS_TO_SEED.filter((fund) => !existingByName.has(fund.name));

    if (missingFunds.length === 0) {
      console.log(`[seed-funds] Nothing to insert for org ${orgId}.`);
      return;
    }

    const inserted = await tx
      .insert(funds)
      .values(missingFunds.map((fund) => ({ ...fund, orgId })))
      .returning({ id: funds.id, name: funds.name });

    console.log(
      `[seed-funds] Inserted ${inserted.length} funds: ${inserted.map((fund) => fund.name).join(", ")}`,
    );
  });

  console.log("[seed-funds] Done.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[seed-funds] Failed:", error);
    process.exit(1);
  });
