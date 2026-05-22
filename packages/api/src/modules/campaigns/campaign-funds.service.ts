/**
 * Campaign-funds routing service — manages the campaign_funds junction table
 * for multi-fund split routing (ADR-031 §2.5, Epic #416 Task 4).
 *
 * Invariants enforced on every write:
 *   1. Single fund per campaign: splitPct may be NULL; isOnlineDefault is
 *      implicitly true (no row-level check needed).
 *   2. Multiple funds: exactly ONE row must have isOnlineDefault = true.
 *   3. Multiple funds: SUM(splitPct) must equal 100.00.
 *   4. Multiple funds: all splitPct values must be non-null.
 *   5. All funds must belong to the same orgId as the campaign (cross-org → 404).
 */

import { bankAccounts, campaignFunds, campaigns, funds } from "@givernance/shared/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CampaignFundRow {
  id: string;
  campaignId: string;
  fundId: string;
  fundName: string;
  splitPct: string | null;
  isOnlineDefault: boolean;
  sortOrder: number;
  settlementCurrency: string | null;
}

export interface AddCampaignFundPayload {
  fundId: string;
  splitPct?: string | null;
  isOnlineDefault?: boolean;
  sortOrder?: number;
}

export interface UpdateCampaignFundPatch {
  splitPct?: string | null;
  isOnlineDefault?: boolean;
  sortOrder?: number;
}

/** Structured error for 422 invariant violations. */
export class CampaignFundInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignFundInvariantError";
  }
}

/** Raised when the fund or campaign-fund row does not exist (→ 404). */
export class CampaignFundNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignFundNotFoundError";
  }
}

// ─── Invariant Validator ──────────────────────────────────────────────────────

/**
 * Validate the campaign_funds invariants for a given campaign after a
 * potential write. Reads the current state from the DB (within the same
 * transaction context) and checks:
 *
 *   - 0 rows → skip (empty state is always valid)
 *   - 1 row  → splitPct may be null; isOnlineDefault irrelevant → valid
 *   - >1 rows → exactly one isOnlineDefault=true, all splitPct non-null,
 *               SUM(splitPct) == 100.00 (tolerance 0.01)
 *
 * Returns an error description string on failure, or null on success.
 */
async function validateCampaignFundsInvariants(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  campaignId: string,
): Promise<string | null> {
  const rows = await tx
    .select({
      splitPct: campaignFunds.splitPct,
      isOnlineDefault: campaignFunds.isOnlineDefault,
    })
    .from(campaignFunds)
    .where(eq(campaignFunds.campaignId, campaignId));

  if (rows.length <= 1) {
    // 0 rows (empty) or 1 row — always valid
    return null;
  }

  // Multiple funds: all splitPct must be non-null
  const anyNull = rows.some((r) => r.splitPct === null || r.splitPct === undefined);
  if (anyNull) {
    return "When multiple funds are assigned to a campaign, every fund must have a split percentage.";
  }

  // Multiple funds: exactly one isOnlineDefault
  const defaultCount = rows.filter((r) => r.isOnlineDefault).length;
  if (defaultCount !== 1) {
    return `Exactly one fund per campaign must be marked as the online default (found ${defaultCount}).`;
  }

  // Multiple funds: SUM(splitPct) must equal 100.00 (allow 0.01 tolerance)
  const sum = rows.reduce((acc, r) => acc + Number(r.splitPct), 0);
  if (Math.abs(sum - 100) >= 0.01) {
    return `Split percentages must sum to 100.00 (currently ${sum.toFixed(2)}).`;
  }

  return null;
}

// ─── Service Functions ────────────────────────────────────────────────────────

/**
 * List all campaign_funds rows for a campaign, joined with fund name and
 * settlement currency.
 *
 * Returns null when the campaign does not exist or does not belong to orgId.
 */
export async function listCampaignFundRouting(
  campaignId: string,
  orgId: string,
): Promise<CampaignFundRow[] | null> {
  return withTenantContext(orgId, async (tx) => {
    // Verify campaign exists and belongs to orgId
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const rows = await tx
      .select({
        id: campaignFunds.id,
        campaignId: campaignFunds.campaignId,
        fundId: campaignFunds.fundId,
        fundName: funds.name,
        splitPct: campaignFunds.splitPct,
        isOnlineDefault: campaignFunds.isOnlineDefault,
        sortOrder: campaignFunds.sortOrder,
        settlementCurrency: bankAccounts.currency,
      })
      .from(campaignFunds)
      .innerJoin(funds, eq(funds.id, campaignFunds.fundId))
      .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
      .where(and(eq(campaignFunds.campaignId, campaignId), eq(campaignFunds.orgId, orgId)))
      .orderBy(campaignFunds.sortOrder, campaignFunds.fundId);

    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      fundId: r.fundId,
      fundName: r.fundName,
      splitPct: r.splitPct ?? null,
      isOnlineDefault: r.isOnlineDefault,
      sortOrder: r.sortOrder,
      settlementCurrency: r.settlementCurrency ?? null,
    }));
  });
}

/**
 * Add a fund to a campaign's routing table.
 *
 * Throws CampaignFundNotFoundError (→ 404) when:
 *   - The campaign does not exist / does not belong to orgId
 *   - The fund does not exist / does not belong to orgId
 *
 * Throws CampaignFundInvariantError (→ 422) when the result would violate
 * the multi-fund invariants.
 */
export async function addCampaignFund(
  campaignId: string,
  orgId: string,
  payload: AddCampaignFundPayload,
): Promise<CampaignFundRow> {
  return withTenantContext(orgId, async (tx) => {
    // Verify campaign exists and belongs to orgId
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) {
      throw new CampaignFundNotFoundError("Campaign not found");
    }

    // Verify fund exists and belongs to orgId (cross-org → 404)
    const [fund] = await tx
      .select({ id: funds.id })
      .from(funds)
      .where(and(eq(funds.id, payload.fundId), eq(funds.orgId, orgId)));

    if (!fund) {
      throw new CampaignFundNotFoundError("Fund not found in this organisation");
    }

    // Insert row
    await tx.insert(campaignFunds).values({
      orgId,
      campaignId,
      fundId: payload.fundId,
      splitPct: payload.splitPct ?? null,
      isOnlineDefault: payload.isOnlineDefault ?? false,
      sortOrder: payload.sortOrder ?? 0,
    });

    // Validate invariants after insert
    const violation = await validateCampaignFundsInvariants(tx, campaignId);
    if (violation) {
      throw new CampaignFundInvariantError(violation);
    }

    // Return the inserted row with fund join
    const [row] = await tx
      .select({
        id: campaignFunds.id,
        campaignId: campaignFunds.campaignId,
        fundId: campaignFunds.fundId,
        fundName: funds.name,
        splitPct: campaignFunds.splitPct,
        isOnlineDefault: campaignFunds.isOnlineDefault,
        sortOrder: campaignFunds.sortOrder,
        settlementCurrency: bankAccounts.currency,
      })
      .from(campaignFunds)
      .innerJoin(funds, eq(funds.id, campaignFunds.fundId))
      .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
      .where(
        and(
          eq(campaignFunds.campaignId, campaignId),
          eq(campaignFunds.fundId, payload.fundId),
          eq(campaignFunds.orgId, orgId),
        ),
      );

    if (!row) {
      throw new Error("Failed to retrieve inserted campaign fund row");
    }

    return {
      id: row.id,
      campaignId: row.campaignId,
      fundId: row.fundId,
      fundName: row.fundName,
      splitPct: row.splitPct ?? null,
      isOnlineDefault: row.isOnlineDefault,
      sortOrder: row.sortOrder,
      settlementCurrency: row.settlementCurrency ?? null,
    };
  });
}

/**
 * Update a campaign_funds row (partial patch).
 *
 * Throws CampaignFundNotFoundError (→ 404) when the row does not exist.
 * Throws CampaignFundInvariantError (→ 422) when the patch would violate
 * the multi-fund invariants.
 */
export async function updateCampaignFund(
  campaignId: string,
  fundId: string,
  orgId: string,
  patch: UpdateCampaignFundPatch,
): Promise<CampaignFundRow> {
  return withTenantContext(orgId, async (tx) => {
    // Verify the row exists
    const [existing] = await tx
      .select({ id: campaignFunds.id })
      .from(campaignFunds)
      .where(
        and(
          eq(campaignFunds.campaignId, campaignId),
          eq(campaignFunds.fundId, fundId),
          eq(campaignFunds.orgId, orgId),
        ),
      );

    if (!existing) {
      throw new CampaignFundNotFoundError("Campaign fund assignment not found");
    }

    // Build update payload — only include keys that were provided
    const updateValues: Partial<{
      splitPct: string | null;
      isOnlineDefault: boolean;
      sortOrder: number;
    }> = {};

    if ("splitPct" in patch) updateValues.splitPct = patch.splitPct ?? null;
    if ("isOnlineDefault" in patch) updateValues.isOnlineDefault = patch.isOnlineDefault;
    if ("sortOrder" in patch) updateValues.sortOrder = patch.sortOrder;

    if (Object.keys(updateValues).length > 0) {
      await tx
        .update(campaignFunds)
        .set(updateValues)
        .where(
          and(
            eq(campaignFunds.campaignId, campaignId),
            eq(campaignFunds.fundId, fundId),
            eq(campaignFunds.orgId, orgId),
          ),
        );
    }

    // Validate invariants after update
    const violation = await validateCampaignFundsInvariants(tx, campaignId);
    if (violation) {
      throw new CampaignFundInvariantError(violation);
    }

    // Return the updated row with fund join
    const [row] = await tx
      .select({
        id: campaignFunds.id,
        campaignId: campaignFunds.campaignId,
        fundId: campaignFunds.fundId,
        fundName: funds.name,
        splitPct: campaignFunds.splitPct,
        isOnlineDefault: campaignFunds.isOnlineDefault,
        sortOrder: campaignFunds.sortOrder,
        settlementCurrency: bankAccounts.currency,
      })
      .from(campaignFunds)
      .innerJoin(funds, eq(funds.id, campaignFunds.fundId))
      .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
      .where(
        and(
          eq(campaignFunds.campaignId, campaignId),
          eq(campaignFunds.fundId, fundId),
          eq(campaignFunds.orgId, orgId),
        ),
      );

    if (!row) {
      throw new Error("Failed to retrieve updated campaign fund row");
    }

    return {
      id: row.id,
      campaignId: row.campaignId,
      fundId: row.fundId,
      fundName: row.fundName,
      splitPct: row.splitPct ?? null,
      isOnlineDefault: row.isOnlineDefault,
      sortOrder: row.sortOrder,
      settlementCurrency: row.settlementCurrency ?? null,
    };
  });
}

/**
 * Remove a fund from a campaign's routing table.
 *
 * Throws CampaignFundNotFoundError (→ 404) when the row does not exist.
 * Throws CampaignFundInvariantError (→ 422) when the fund is the online
 * default and other funds are still assigned to the campaign.
 */
export async function removeCampaignFund(
  campaignId: string,
  fundId: string,
  orgId: string,
): Promise<void> {
  return withTenantContext(orgId, async (tx) => {
    // Verify the row exists and capture isOnlineDefault
    const [existing] = await tx
      .select({ id: campaignFunds.id, isOnlineDefault: campaignFunds.isOnlineDefault })
      .from(campaignFunds)
      .where(
        and(
          eq(campaignFunds.campaignId, campaignId),
          eq(campaignFunds.fundId, fundId),
          eq(campaignFunds.orgId, orgId),
        ),
      );

    if (!existing) {
      throw new CampaignFundNotFoundError("Campaign fund assignment not found");
    }

    // If this is the online default, check whether other funds remain
    if (existing.isOnlineDefault) {
      const countResult = await tx
        .select({ otherCount: sql<number>`count(*)` })
        .from(campaignFunds)
        .where(
          and(
            eq(campaignFunds.campaignId, campaignId),
            eq(campaignFunds.orgId, orgId),
            ne(campaignFunds.fundId, fundId),
          ),
        );
      const otherCount = Number(countResult[0]?.otherCount ?? 0);

      if (otherCount > 0) {
        throw new CampaignFundInvariantError(
          "Cannot remove the online-default fund while other funds are assigned to this campaign.",
        );
      }
    }

    await tx
      .delete(campaignFunds)
      .where(
        and(
          eq(campaignFunds.campaignId, campaignId),
          eq(campaignFunds.fundId, fundId),
          eq(campaignFunds.orgId, orgId),
        ),
      );
  });
}
