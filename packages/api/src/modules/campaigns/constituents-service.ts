/**
 * Campaign-constituents service — explicit membership of constituents in a
 * campaign (Epic #274). Independent of donations and generated documents,
 * so the postal recipient list can be assembled before any letter exists.
 */

import {
  campaignConstituents,
  campaigns,
  constituents,
  donations,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export class CampaignMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignMembershipError";
  }
}

export interface CampaignMember {
  id: string;
  constituentId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  type: string;
  addedAt: string;
  /** Sum of cleared donations (in base cents) attributed to this campaign so far. */
  campaignDonationCents: number;
}

export interface ListMembersQuery {
  page: number;
  perPage: number;
}

/** List the constituents linked to a campaign with their per-campaign donation total. */
export async function listCampaignMembers(
  orgId: string,
  campaignId: string,
  query: ListMembersQuery,
): Promise<{ data: CampaignMember[]; pagination: Pagination } | null> {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    // Per-campaign donation aggregate (cleared minus refunded). LEFT JOINed
    // so a constituent linked but never donated still appears at 0.
    const aggregatedDonations = tx
      .select({
        constituentId: donations.constituentId,
        totalCents: sql<number>`COALESCE(SUM(CASE
          WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
          WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
          ELSE 0
        END), 0)::int`.as("campaign_donation_cents"),
      })
      .from(donations)
      .where(and(eq(donations.orgId, orgId), eq(donations.campaignId, campaignId)))
      .groupBy(donations.constituentId)
      .as("campaign_donations");

    const [data, countResult] = await Promise.all([
      tx
        .select({
          id: campaignConstituents.id,
          constituentId: constituents.id,
          firstName: constituents.firstName,
          lastName: constituents.lastName,
          email: constituents.email,
          type: constituents.type,
          addedAt: campaignConstituents.addedAt,
          campaignDonationCents: aggregatedDonations.totalCents,
        })
        .from(campaignConstituents)
        .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
        .leftJoin(aggregatedDonations, eq(aggregatedDonations.constituentId, constituents.id))
        .where(
          and(
            eq(campaignConstituents.orgId, orgId),
            eq(campaignConstituents.campaignId, campaignId),
            isNull(constituents.deletedAt),
          ),
        )
        .orderBy(sql`${campaignConstituents.addedAt} DESC`)
        .limit(perPage)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)` })
        .from(campaignConstituents)
        .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
        .where(
          and(
            eq(campaignConstituents.orgId, orgId),
            eq(campaignConstituents.campaignId, campaignId),
            isNull(constituents.deletedAt),
          ),
        ),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    const rows: CampaignMember[] = data.map((row) => ({
      id: row.id,
      constituentId: row.constituentId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      type: row.type,
      addedAt: row.addedAt instanceof Date ? row.addedAt.toISOString() : String(row.addedAt),
      campaignDonationCents: Number(row.campaignDonationCents ?? 0),
    }));

    return {
      data: rows,
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    };
  });
}

export interface AddMembersResult {
  added: number;
  skipped: number;
}

/**
 * Bulk-add constituents to a campaign. Idempotent — duplicates (same
 * `(orgId, campaignId, constituentId)`) are silently skipped via
 * ON CONFLICT DO NOTHING. Throws `CampaignMembershipError` when any
 * constituent id does not belong to this org or has been soft-deleted.
 */
export async function addCampaignMembers(
  orgId: string,
  userId: string,
  campaignId: string,
  constituentIds: string[],
): Promise<AddMembersResult | null> {
  const uniqueIds = Array.from(new Set(constituentIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { added: 0, skipped: 0 };
  }

  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id, type: campaigns.type })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    if (campaign.type === "door_drop") {
      throw new CampaignMembershipError(
        "Cannot link constituents to a door_drop campaign — by definition there is no recipient list",
      );
    }

    const existingConstituents = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(
        and(
          inArray(constituents.id, uniqueIds),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      );

    if (existingConstituents.length !== uniqueIds.length) {
      throw new CampaignMembershipError(
        "One or more constituents were not found in this organization",
      );
    }

    const insertResult = await tx
      .insert(campaignConstituents)
      .values(
        uniqueIds.map((cId) => ({
          orgId,
          campaignId,
          constituentId: cId,
          addedBy: userId,
        })),
      )
      .onConflictDoNothing({
        target: [
          campaignConstituents.orgId,
          campaignConstituents.campaignId,
          campaignConstituents.constituentId,
        ],
      })
      .returning({ id: campaignConstituents.id });

    const added = insertResult.length;
    const skipped = uniqueIds.length - added;

    if (added > 0) {
      await tx.insert(outboxEvents).values({
        tenantId: orgId,
        type: "campaign.constituents_added",
        payload: {
          campaignId,
          added,
          skipped,
          addedBy: userId,
        },
      });
    }

    return { added, skipped };
  });
}

/** Remove a single constituent from a campaign. Returns null if campaign or link not found. */
export async function removeCampaignMember(
  orgId: string,
  userId: string,
  campaignId: string,
  constituentId: string,
): Promise<{ removed: boolean } | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const deleted = await tx
      .delete(campaignConstituents)
      .where(
        and(
          eq(campaignConstituents.orgId, orgId),
          eq(campaignConstituents.campaignId, campaignId),
          eq(campaignConstituents.constituentId, constituentId),
        ),
      )
      .returning({ id: campaignConstituents.id });

    if (deleted.length === 0) {
      return { removed: false };
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.constituent_removed",
      payload: {
        campaignId,
        constituentId,
        removedBy: userId,
      },
    });

    return { removed: true };
  });
}
