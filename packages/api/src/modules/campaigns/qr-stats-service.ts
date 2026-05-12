/**
 * Campaign QR-tracking metrics (Epic #274 + Epic #318 PR #5 extension).
 *
 * Drives the admin's "donations from postal scans" widget — and (when
 * the campaign has a linked bank account) also the Swiss QR-bill rail
 * metrics per docs/25 §5.3. Both rails live in one merged shape so the
 * existing `qr-tracking-card.tsx` is extended in place, not duplicated.
 *
 * The Swiss-rail block is mode-aware: some fields are `null` on
 * door-drop because the underlying signal doesn't exist (e.g.
 * `pendingQrBills` makes no sense when the donor count is open-ended).
 */

import {
  campaignQrCodes,
  campaigns,
  camtStatements,
  camtUnreconciledEntries,
  donations,
  swissQrReferences,
} from "@givernance/shared/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface CampaignSwissRailStats {
  /** Per docs/25 §5.3 table — count of `swiss_qr_references`. */
  totalQrBills: number;
  /** Personalised: count of donations linked via swiss_qr_reference_id. Door-drop: distinct constituents. */
  paidQrBills: number;
  /** Sum of camt.053-attributed donation amount_cents. */
  paidQrBillAmountCents: number;
  /** Personalised only — `totalQrBills - paidQrBills`. NULL on door-drop. */
  pendingQrBills: number | null;
  /** Donations whose amount differs from the printed reference amount (when non-zero). */
  partialMatchCount: number;
  /** `camt_unreconciled_entries` linked to this campaign's bank account, status=pending. */
  unreconciledCount: number;
  /** MAX `camt_statements.processed_at` for the campaign's bank account. */
  lastStatementImportedAt: string | null;
}

export interface CampaignQrStats {
  campaignId: string;
  /** Total number of QR codes ever generated for this campaign. */
  totalCodes: number;
  /** Number of distinct codes that have been scanned at least once. */
  scannedCodes: number;
  /**
   * Number of **cleared** donations reconciled through one of those QR codes
   * (donations.qr_code_id IS NOT NULL AND status = 'cleared'). Refunded
   * donations are excluded from the count — they are no longer "attributed
   * conversions" once the donor's money has been returned. The amount
   * field below stays net-of-refunds so the headline number matches the
   * dashboard, but the count tracks live attribution.
   */
  qrAttributedDonations: number;
  /** Total cleared base-cents reconciled via QR codes, net of refunds. */
  qrAttributedAmountCents: number;
  /**
   * Swiss QR-bill rail metrics (Epic #318, docs/25 §5.3). Null when
   * the campaign has no linked `bank_account_id` (standard French
   * rail only — no QR-bills minted).
   */
  swissRail: CampaignSwissRailStats | null;
}

export async function getCampaignQrStats(
  orgId: string,
  campaignId: string,
): Promise<CampaignQrStats | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id, bankAccountId: campaigns.bankAccountId })
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
        donationCount: sql<number>`count(*) FILTER (WHERE ${donations.status} = 'cleared')::int`,
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

    // ── Swiss QR-bill rail metrics (Epic #318, docs/25 §5.3). ──────
    // Only computed when the campaign has a linked bank account; for
    // standard French-rail campaigns the swissRail field is null.
    const swissRail = campaign.bankAccountId
      ? await getCampaignSwissRailStats(tx, orgId, campaignId, campaign.bankAccountId)
      : null;

    return {
      campaignId,
      totalCodes: Number(codeStats?.totalCodes ?? 0),
      scannedCodes: Number(codeStats?.scannedCodes ?? 0),
      qrAttributedDonations: Number(donationStats?.donationCount ?? 0),
      qrAttributedAmountCents: Number(donationStats?.amountCents ?? 0),
      swissRail,
    };
  });
}

/**
 * Compute the Swiss QR-bill rail block. Extracted from `getCampaignQrStats`
 * to keep that function under the cognitive-complexity ceiling and so
 * the worker integration tests can target this function directly.
 *
 * `pendingQrBills` is computed naively as `totalQrBills - paidQrBills`
 * for personalised campaigns. Door-drop has one reference per export
 * regardless of how many donors actually pay, so the "pending" notion
 * doesn't apply — we return null to keep the UI honest.
 */
async function getCampaignSwissRailStats(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
  bankAccountId: string,
): Promise<CampaignSwissRailStats> {
  // Total minted references for this campaign.
  const [refCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(swissQrReferences)
    .where(and(eq(swissQrReferences.orgId, orgId), eq(swissQrReferences.campaignId, campaignId)));

  // Mode discriminator — personalised refs have constituent_id set,
  // door-drop has at most one row with constituent_id=NULL per export.
  const [refMode] = await tx
    .select({
      personalisedCount: sql<number>`count(*) FILTER (WHERE ${swissQrReferences.constituentId} IS NOT NULL)::int`,
      doorDropCount: sql<number>`count(*) FILTER (WHERE ${swissQrReferences.constituentId} IS NULL)::int`,
    })
    .from(swissQrReferences)
    .where(and(eq(swissQrReferences.orgId, orgId), eq(swissQrReferences.campaignId, campaignId)));
  const isDoorDrop =
    Number(refMode?.doorDropCount ?? 0) > 0 && Number(refMode?.personalisedCount ?? 0) === 0;

  // Paid + partial-match metrics — joined via swiss_qr_reference_id
  // on donations.
  const [paidStats] = await tx
    .select({
      paidCount: sql<number>`count(DISTINCT ${donations.id}) FILTER (WHERE ${donations.status} = 'cleared')::int`,
      amountCents: sql<number>`COALESCE(SUM(${donations.amountCents}) FILTER (WHERE ${donations.status} = 'cleared'), 0)::int`,
      partialMatchCount: sql<number>`count(*) FILTER (
        WHERE ${donations.status} = 'cleared'
        AND ${swissQrReferences.amountCents} > 0
        AND ${donations.amountCents} <> ${swissQrReferences.amountCents}
      )::int`,
    })
    .from(donations)
    .innerJoin(swissQrReferences, eq(donations.swissQrReferenceId, swissQrReferences.id))
    .where(
      and(
        eq(donations.orgId, orgId),
        eq(donations.campaignId, campaignId),
        isNotNull(donations.swissQrReferenceId),
      ),
    );

  // Door-drop `paidQrBills` counts DISTINCT debtor IBANs from the
  // camt.053 credit entries that matched this campaign's references,
  // NOT distinct constituents. Sticky by IBAN, not by constituent —
  // docs/25 §5.3 financial-integrity rule (GDPR Art. 17 must not
  // silently change the count). If we counted distinct constituents,
  // a donor's erasure would silently decrement the historical paid
  // count, mis-representing financial reality. TWINT-anonymised
  // entries with NULL debtor_iban are excluded from the distinct count
  // (they ARE real matched donations but we can't honour the
  // sticky-distinct semantic without an IBAN — the operator sees them
  // in the no_debtor_info / unreconciled surface separately when they
  // don't auto-match).
  let doorDropPaidCount = 0;
  if (isDoorDrop) {
    const ddRows = await tx.execute(sql<{ count: number }>`
      SELECT count(DISTINCT ce.debtor_iban)::int AS count
      FROM camt_credit_entries ce
      JOIN donations d ON d.id = ce.donation_id
      WHERE ce.org_id = ${orgId}
        AND d.campaign_id = ${campaignId}
        AND d.status = 'cleared'
        AND ce.debtor_iban IS NOT NULL
    `);
    doorDropPaidCount = Number(
      (ddRows as unknown as { rows: Array<{ count: number }> }).rows?.[0]?.count ?? 0,
    );
  }

  const totalQrBills = Number(refCount?.count ?? 0);
  const paidQrBills = isDoorDrop ? doorDropPaidCount : Number(paidStats?.paidCount ?? 0);

  // Unreconciled count — joined via the bank_account_id on the
  // statement (one bank account can clear donations across many
  // campaigns, so the unreconciled queue is bank-account-scoped, not
  // campaign-scoped; we surface the total at the bank-account level).
  const [unrecCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(camtUnreconciledEntries)
    .innerJoin(camtStatements, eq(camtUnreconciledEntries.creditEntryId, camtStatements.id))
    // The join condition above is wrong on purpose for the COUNT
    // shape — the real join is via camt_credit_entries — but to keep
    // the SQL simple we count via a sub-select below. See follow-up.
    // (Drizzle's groupBy support for this shape is verbose; the
    // explicit query below replaces it.)
    .where(
      and(
        eq(camtUnreconciledEntries.orgId, orgId),
        eq(camtStatements.bankAccountId, bankAccountId),
        eq(camtUnreconciledEntries.status, "pending"),
      ),
    )
    .limit(0);
  void unrecCount; // see correct query below

  // Correct unreconciled count via raw SQL: 2-step join through
  // camt_credit_entries. Drizzle's relational helpers don't compose
  // well across three tables for a simple count.
  const unrecRows = await tx.execute(sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM camt_unreconciled_entries ue
    JOIN camt_credit_entries ce ON ce.id = ue.credit_entry_id
    JOIN camt_statements cs ON cs.id = ce.statement_id
    WHERE ue.org_id = ${orgId}
      AND cs.bank_account_id = ${bankAccountId}
      AND ue.status = 'pending'
  `);
  const unreconciledCount = Number(
    (unrecRows as unknown as { rows: Array<{ count: number }> }).rows?.[0]?.count ?? 0,
  );

  // Last statement processed_at for this bank account.
  const [lastStmt] = await tx
    .select({ lastProcessedAt: sql<Date | null>`MAX(${camtStatements.processedAt})` })
    .from(camtStatements)
    .where(and(eq(camtStatements.orgId, orgId), eq(camtStatements.bankAccountId, bankAccountId)));

  return {
    totalQrBills,
    paidQrBills,
    paidQrBillAmountCents: Number(paidStats?.amountCents ?? 0),
    pendingQrBills: isDoorDrop ? null : Math.max(0, totalQrBills - paidQrBills),
    partialMatchCount: Number(paidStats?.partialMatchCount ?? 0),
    unreconciledCount,
    lastStatementImportedAt:
      lastStmt?.lastProcessedAt instanceof Date ? lastStmt.lastProcessedAt.toISOString() : null,
  };
}
