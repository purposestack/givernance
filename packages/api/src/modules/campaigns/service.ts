/** Campaigns service — business logic for postal campaign operations */

import { campaignDocuments, campaigns, donations, outboxEvents } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface CreateCampaignInput {
  name: string;
  type: "nominative_postal" | "door_drop" | "digital";
  parentId?: string | null;
  costCents?: number | null;
}

export interface UpdateCampaignInput {
  name?: string;
  type?: "nominative_postal" | "door_drop" | "digital";
  status?: "draft" | "active" | "closed";
  parentId?: string | null;
  costCents?: number | null;
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
export async function createCampaign(orgId: string, input: CreateCampaignInput, userId?: string) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        orgId,
        name: input.name,
        type: input.type,
        parentId: input.parentId ?? null,
        costCents: input.costCents ?? null,
      })
      .returning();

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.updated",
      payload: { campaignId: campaign?.id, changes: input, action: "created", updatedBy: userId },
    });

    return campaign;
  });
}

/** Get a single campaign by ID */
export async function getCampaign(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)));

    return row ?? null;
  });
}

/** Update a campaign (partial update) */
export async function updateCampaign(
  orgId: string,
  id: string,
  input: UpdateCampaignInput,
  userId: string,
) {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)));

    if (!existing) return null;

    const [updated] = await tx
      .update(campaigns)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(campaigns.id, id))
      .returning();

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.updated",
      payload: { campaignId: id, changes: input, action: "updated", updatedBy: userId },
    });

    return updated;
  });
}

/** Close (soft-delete) a campaign by setting status to 'closed' */
export async function closeCampaign(orgId: string, id: string, userId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)));

    if (!existing) return null;

    const now = new Date();
    const [closed] = await tx
      .update(campaigns)
      .set({ status: "closed", updatedAt: now })
      .where(eq(campaigns.id, id))
      .returning();

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.updated",
      payload: {
        campaignId: id,
        changes: { status: "closed" },
        action: "closed",
        updatedBy: userId,
      },
    });

    return closed;
  });
}

/** Get campaign stats: total raised, donation count, unique donors */
export async function getCampaignStats(orgId: string, campaignId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [stats] = await tx
      .select({
        totalRaisedCents: sql<number>`COALESCE(SUM(${donations.amountCents}), 0)`,
        donationCount: sql<number>`COUNT(${donations.id})`,
        uniqueDonors: sql<number>`COUNT(DISTINCT ${donations.constituentId})`,
      })
      .from(donations)
      .where(and(eq(donations.campaignId, campaignId), eq(donations.orgId, orgId)));

    return {
      campaignId,
      totalRaisedCents: Number(stats?.totalRaisedCents ?? 0),
      donationCount: Number(stats?.donationCount ?? 0),
      uniqueDonors: Number(stats?.uniqueDonors ?? 0),
    };
  });
}

/** Get campaign ROI: (totalRaised - costCents) / costCents */
export async function getCampaignRoi(orgId: string, campaignId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [stats] = await tx
      .select({
        totalRaisedCents: sql<number>`COALESCE(SUM(${donations.amountCents}), 0)`,
      })
      .from(donations)
      .where(and(eq(donations.campaignId, campaignId), eq(donations.orgId, orgId)));

    const totalRaisedCents = Number(stats?.totalRaisedCents ?? 0);
    const costCents = campaign.costCents ?? 0;
    const roi = costCents > 0 ? (totalRaisedCents - costCents) / costCents : null;

    return {
      campaignId,
      totalRaisedCents,
      costCents,
      roi,
    };
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
