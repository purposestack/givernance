/**
 * Campaign-constituents linking service (Epic #274).
 *
 * Lets an org curate the recipient list of a postal campaign without
 * creating placeholder donations. Used by:
 *   - The "Constituents on this campaign" panel in the campaign detail UI.
 *   - The export pipeline, which fans out PDF generation over the linked
 *     constituents instead of an arbitrary array passed at request time.
 */

import {
  type CampaignType,
  campaignConstituents,
  campaigns,
  constituents,
  donations,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface LinkedConstituentRow {
  id: string;
  constituentId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  type: string;
  addedByUserId: string | null;
  createdAt: Date;
  /** Net cleared - refunded base cents tied to this campaign + constituent (Epic #274 reconciliation). */
  reconciledAmountCents: number;
  reconciledDonationCount: number;
}

export interface ListLinkedConstituentsQuery {
  page: number;
  perPage: number;
  search?: string;
}

/** Verify the campaign exists in the org. Returns the campaign row or `null`. */
async function loadCampaignForOrg(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
) {
  const [row] = await tx
    .select({ id: campaigns.id, type: campaigns.type, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
  return row ?? null;
}

/** Custom error for invalid linkage operations (e.g. attaching to a door-drop campaign). */
export class CampaignLinkError extends Error {
  constructor(
    message: string,
    readonly code: "campaign_not_found" | "invalid_campaign_type" | "constituent_not_found",
  ) {
    super(message);
    this.name = "CampaignLinkError";
  }
}

/**
 * Attach a list of constituents to a campaign. Idempotent: re-attaching is
 * a no-op via `ON CONFLICT DO NOTHING`. Door-drop campaigns reject linkage
 * because their export is tenant-wide, not constituent-scoped.
 *
 * Returns the count of new attachments (not existing duplicates).
 */
export async function attachConstituents(
  orgId: string,
  campaignId: string,
  constituentIds: string[],
  userId: string | null,
): Promise<{ attached: number; skipped: number }> {
  const uniqueIds = Array.from(new Set(constituentIds));
  if (uniqueIds.length === 0) return { attached: 0, skipped: 0 };

  return withTenantContext(orgId, async (tx) => {
    const campaign = await loadCampaignForOrg(tx, orgId, campaignId);
    if (!campaign) {
      throw new CampaignLinkError("Campaign not found", "campaign_not_found");
    }
    if (campaign.type === "door_drop") {
      throw new CampaignLinkError(
        "Door-drop campaigns do not support per-constituent linkage",
        "invalid_campaign_type",
      );
    }

    // Verify every requested constituent belongs to the org and is not soft-deleted.
    const matchingRows = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(
        and(
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
          inArray(constituents.id, uniqueIds),
        ),
      );

    if (matchingRows.length !== uniqueIds.length) {
      throw new CampaignLinkError(
        "One or more constituents were not found in this organization",
        "constituent_not_found",
      );
    }

    const insertResult = await tx
      .insert(campaignConstituents)
      .values(
        uniqueIds.map((cid) => ({
          orgId,
          campaignId,
          constituentId: cid,
          addedByUserId: userId,
        })),
      )
      .onConflictDoNothing({
        target: [campaignConstituents.campaignId, campaignConstituents.constituentId],
      })
      .returning({ id: campaignConstituents.id });

    const attached = insertResult.length;
    const skipped = uniqueIds.length - attached;

    // Audit trail — only emit if anything actually changed, so re-fires
    // (a UI double-click) don't pollute the outbox.
    if (attached > 0) {
      await tx.insert(outboxEvents).values({
        tenantId: orgId,
        type: "campaign.constituents_attached",
        payload: {
          campaignId,
          constituentIds: uniqueIds,
          attachedCount: attached,
          skippedCount: skipped,
          attachedBy: userId,
        },
      });
    }

    return { attached, skipped };
  });
}

/**
 * Detach a constituent from a campaign. Returns `false` if the link did
 * not exist (404), `true` if the row was removed.
 */
export async function detachConstituent(
  orgId: string,
  campaignId: string,
  constituentId: string,
  userId: string | null,
): Promise<boolean> {
  return withTenantContext(orgId, async (tx) => {
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

    if (deleted.length === 0) return false;

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.constituent_detached",
      payload: { campaignId, constituentId, detachedBy: userId },
    });

    return true;
  });
}

/**
 * List constituents linked to a campaign with pagination. Each row carries
 * the per-constituent reconciled amount (cleared - refunded base cents
 * scoped to (campaign, constituent)) so the admin UI can render the
 * "Donations reconciled via this campaign" indicator inline. Issue #274.
 */
export async function listLinkedConstituents(
  orgId: string,
  campaignId: string,
  query: ListLinkedConstituentsQuery,
): Promise<{ data: LinkedConstituentRow[]; pagination: Pagination; campaignType: CampaignType }> {
  const { page, perPage, search } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const campaign = await loadCampaignForOrg(tx, orgId, campaignId);
    if (!campaign) {
      throw new CampaignLinkError("Campaign not found", "campaign_not_found");
    }

    const reconciledSq = tx
      .select({
        constituentId: donations.constituentId,
        amountCents: sql<number | null>`SUM(CASE
          WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
          WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
          ELSE 0
        END)`.as("reconciled_amount_cents"),
        donationCount: sql<number | null>`COUNT(CASE
          WHEN ${donations.status} IN ('cleared', 'refunded') THEN 1
        END)`.as("reconciled_count"),
      })
      .from(donations)
      .where(and(eq(donations.orgId, orgId), eq(donations.campaignId, campaignId)))
      .groupBy(donations.constituentId)
      .as("reconciled");

    const conditions = [
      eq(campaignConstituents.orgId, orgId),
      eq(campaignConstituents.campaignId, campaignId),
      isNull(constituents.deletedAt),
    ];
    if (search) {
      const pattern = `%${search}%`;
      const searchCondition = or(
        ilike(constituents.firstName, pattern),
        ilike(constituents.lastName, pattern),
        ilike(constituents.email, pattern),
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    const where = and(...conditions);

    const [data, countResult] = await Promise.all([
      tx
        .select({
          id: campaignConstituents.id,
          constituentId: campaignConstituents.constituentId,
          firstName: constituents.firstName,
          lastName: constituents.lastName,
          email: constituents.email,
          type: constituents.type,
          addedByUserId: campaignConstituents.addedByUserId,
          createdAt: campaignConstituents.createdAt,
          reconciledAmountCents: reconciledSq.amountCents,
          reconciledDonationCount: reconciledSq.donationCount,
        })
        .from(campaignConstituents)
        .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
        .leftJoin(reconciledSq, eq(reconciledSq.constituentId, campaignConstituents.constituentId))
        .where(where)
        .orderBy(sql`lower(${constituents.lastName}) ASC, lower(${constituents.firstName}) ASC`)
        .limit(perPage)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)` })
        .from(campaignConstituents)
        .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
        .where(where),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    return {
      data: data.map((row) => ({
        ...row,
        reconciledAmountCents: Number(row.reconciledAmountCents ?? 0),
        reconciledDonationCount: Number(row.reconciledDonationCount ?? 0),
      })),
      pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
      campaignType: campaign.type as CampaignType,
    };
  });
}
