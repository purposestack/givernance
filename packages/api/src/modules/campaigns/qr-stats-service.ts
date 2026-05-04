/**
 * Campaign QR-tracking metrics (Epic #274 comment 2).
 *
 * Drives the admin's "donations from postal scans" widget — surfaces three
 * numbers: total QR codes generated, scanned-at-least-once codes, and the
 * cleared-donation total attributable to those scans (via
 * `donations.qr_code_id`, populated by the Stripe webhook reconciliation
 * path). All three are bounded by the campaign + tenant scope.
 */

import { campaignQrCodes, campaigns, donations } from "@givernance/shared/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface CampaignQrStats {
  campaignId: string;
  /** Total number of QR codes ever generated for this campaign. */
  totalCodes: number;
  /** Number of distinct codes that have been scanned at least once. */
  scannedCodes: number;
  /**
   * Number of cleared donations (in the tenant's base currency) reconciled
   * through one of those QR codes (donations.qr_code_id IS NOT NULL).
   */
  qrAttributedDonations: number;
  /** Total cleared base-cents reconciled via QR codes, net of refunds. */
  qrAttributedAmountCents: number;
}

export async function getCampaignQrStats(
  orgId: string,
  campaignId: string,
): Promise<CampaignQrStats | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [codeStats] = await tx
      .select({
        totalCodes: sql<number>`count(*)::int`,
        scannedCodes: sql<number>`count(*) FILTER (WHERE ${campaignQrCodes.scannedAt} IS NOT NULL)::int`,
      })
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, orgId), eq(campaignQrCodes.campaignId, campaignId)));

    const [donationStats] = await tx
      .select({
        donationCount: sql<number>`count(*) FILTER (WHERE ${donations.status} IN ('cleared', 'refunded'))::int`,
        amountCents: sql<number>`COALESCE(SUM(CASE
          WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
          WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
          ELSE 0
        END), 0)::int`,
      })
      .from(donations)
      .where(
        and(
          eq(donations.orgId, orgId),
          eq(donations.campaignId, campaignId),
          isNotNull(donations.qrCodeId),
        ),
      );

    return {
      campaignId,
      totalCodes: Number(codeStats?.totalCodes ?? 0),
      scannedCodes: Number(codeStats?.scannedCodes ?? 0),
      qrAttributedDonations: Number(donationStats?.donationCount ?? 0),
      qrAttributedAmountCents: Number(donationStats?.amountCents ?? 0),
    };
  });
}
