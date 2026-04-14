/** Campaigns service — business logic for postal campaign operations */

import { campaignDocuments, campaigns, outboxEvents } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface CreateCampaignInput {
  name: string;
  type: "nominative_postal" | "door_drop" | "digital";
}

export interface ListCampaignsQuery {
  page: number;
  perPage: number;
}

/** List campaigns for an organization with pagination */
export async function listCampaigns(orgId: string, query: ListCampaignsQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const where = eq(campaigns.orgId, orgId);

    const [data, countResult] = await Promise.all([
      tx
        .select()
        .from(campaigns)
        .where(where)
        .orderBy(sql`${campaigns.createdAt} DESC`)
        .limit(perPage)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(campaigns).where(where),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    const pagination: Pagination = {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    };

    return { data, pagination };
  });
}

/** Create a new campaign */
export async function createCampaign(orgId: string, input: CreateCampaignInput) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        orgId,
        name: input.name,
        type: input.type,
      })
      .returning();

    return campaign;
  });
}

/** Request document generation for a campaign — emits CampaignDocumentsRequested event transactionally */
export async function requestCampaignDocuments(
  orgId: string,
  userId: string,
  campaignId: string,
  constituentIds: string[],
) {
  return withTenantContext(orgId, async (tx) => {
    // Verify campaign exists and belongs to this org
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    // For door_drop, constituentIds is expected to be empty
    const ids = campaign.type === "door_drop" ? [] : constituentIds;

    // Create placeholder document records
    if (campaign.type === "door_drop") {
      await tx.insert(campaignDocuments).values({
        orgId,
        campaignId,
        constituentId: null,
        s3Path: "pending",
        status: "pending",
      });
    } else {
      if (ids.length > 0) {
        await tx.insert(campaignDocuments).values(
          ids.map((cId) => ({
            orgId,
            campaignId,
            constituentId: cId,
            s3Path: "pending",
            status: "pending" as const,
          })),
        );
      }
    }

    // Emit domain event in the same transaction
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.documents_requested",
      payload: {
        campaignId,
        constituentIds: ids,
        campaignType: campaign.type,
        requestedBy: userId,
      },
    });

    return { campaignId, documentCount: campaign.type === "door_drop" ? 1 : ids.length };
  });
}
