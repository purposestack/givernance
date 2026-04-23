import { campaigns, constituents, donations, tenants } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

/** Export a tenant-scoped JSON snapshot for backup / GL handoff demo flows */
export async function getTenantSnapshot(orgId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, orgId));
    if (!tenant) {
      return null;
    }

    const [campaignRows, constituentRows, donationRows] = await Promise.all([
      tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.orgId, orgId))
        .orderBy(sql`${campaigns.createdAt} ASC`),
      tx
        .select()
        .from(constituents)
        .where(eq(constituents.orgId, orgId))
        .orderBy(sql`${constituents.createdAt} ASC`),
      tx
        .select()
        .from(donations)
        .where(eq(donations.orgId, orgId))
        .orderBy(sql`${donations.donatedAt} ASC`, sql`${donations.createdAt} ASC`),
    ]);

    return {
      orgId,
      exportedAt: new Date().toISOString(),
      campaigns: campaignRows,
      constituents: constituentRows,
      donations: donationRows,
    };
  });
}
