/** Donations service — business logic for donation operations */

import {
  campaigns,
  constituents,
  donationAllocations,
  donations,
  funds,
  outboxEvents,
  receipts,
  tenants,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import { ExchangeRateService } from "../finance/exchange-rate-service.js";

/** Thrown when allocation amounts don't sum to the donation total */
export class AllocationSumMismatchError extends Error {
  constructor(
    public readonly allocSum: number,
    public readonly donationAmount: number,
  ) {
    super(`Allocation sum (${allocSum}) does not equal donation amount (${donationAmount})`);
    this.name = "AllocationSumMismatchError";
  }
}

/**
 * Thrown when a referenced `campaignId` or `fundId` belongs to a different
 * tenant. Route layer maps this to 404 so a curious attacker cannot
 * distinguish "doesn't exist" from "exists in another tenant" (aligns with
 * ADR to be added under issue #56 — cross-tenant 404 vs 422 semantics).
 */
export class CrossTenantReferenceError extends Error {
  constructor(
    public readonly reference: "campaign" | "fund",
    public readonly id: string,
  ) {
    super(`${reference} ${id} not found in tenant`);
    this.name = "CrossTenantReferenceError";
  }
}

async function assertCampaignBelongsToOrg(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string | null | undefined,
): Promise<void> {
  if (!campaignId) return;
  const [row] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
  if (!row) throw new CrossTenantReferenceError("campaign", campaignId);
}

async function assertFundsBelongToOrg(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  allocations: { fundId: string }[] | undefined,
): Promise<void> {
  if (!allocations || allocations.length === 0) return;
  const ids = Array.from(new Set(allocations.map((a) => a.fundId)));
  const rows = await tx
    .select({ id: funds.id })
    .from(funds)
    .where(and(inArray(funds.id, ids), eq(funds.orgId, orgId)));
  const foundIds = new Set(rows.map((r) => r.id));
  const missing = ids.find((id) => !foundIds.has(id));
  if (missing) throw new CrossTenantReferenceError("fund", missing);
}

export interface ListDonationsQuery {
  page: number;
  perPage: number;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  constituentId?: string;
  campaignId?: string;
}

export interface DonationInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  campaignId?: string;
  paymentMethod?: string;
  paymentRef?: string;
  donatedAt?: string;
  fiscalYear?: number;
  allocations?: { fundId: string; amountCents: number }[];
}

export interface DonationUpdateInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  campaignId?: string | null;
  paymentMethod?: string | null;
  paymentRef?: string | null;
  donatedAt?: string;
  fiscalYear?: number | null;
  allocations?: { fundId: string; amountCents: number }[];
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function loadDonationUpdateContext(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  donationId: string,
  constituentId: string,
) {
  const [existing, constituent, tenant] = await Promise.all([
    tx
      .select({ id: donations.id })
      .from(donations)
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId))),
    tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(and(eq(constituents.id, constituentId), eq(constituents.orgId, orgId))),
    tx.select({ baseCurrency: tenants.baseCurrency }).from(tenants).where(eq(tenants.id, orgId)),
  ]);

  return { existing: existing[0] ?? null, constituent: constituent[0] ?? null, tenant: tenant[0] };
}

async function replaceDonationAllocations(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  donationId: string,
  allocations: { fundId: string; amountCents: number }[] | undefined,
) {
  await tx
    .delete(donationAllocations)
    .where(
      and(eq(donationAllocations.donationId, donationId), eq(donationAllocations.orgId, orgId)),
    );

  if (!allocations || allocations.length === 0) {
    return;
  }

  await tx.insert(donationAllocations).values(
    allocations.map((allocation) => ({
      orgId,
      donationId,
      fundId: allocation.fundId,
      amountCents: allocation.amountCents,
    })),
  );
}

/** Build the SQL conditions for a list-donations query */
function listDonationsConditions(orgId: string, query: ListDonationsQuery) {
  const { dateFrom, dateTo, amountMin, amountMax, constituentId, campaignId } = query;
  const conditions = [eq(donations.orgId, orgId)];

  if (dateFrom) conditions.push(gte(donations.donatedAt, new Date(dateFrom)));
  if (dateTo) conditions.push(lte(donations.donatedAt, new Date(dateTo)));
  if (amountMin !== undefined) conditions.push(gte(donations.amountCents, amountMin));
  if (amountMax !== undefined) conditions.push(lte(donations.amountCents, amountMax));
  if (constituentId) conditions.push(eq(donations.constituentId, constituentId));
  if (campaignId) conditions.push(eq(donations.campaignId, campaignId));

  return and(...conditions);
}

/** Enrich donation rows with constituent names and latest receipt status for list views */
async function enrichDonationRows<T extends { id: string; constituentId: string }>(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  rows: T[],
) {
  const constituentIds = Array.from(new Set(rows.map((d) => d.constituentId)));
  const donationIds = rows.map((d) => d.id);

  const [constituentRows, receiptRows] = await Promise.all([
    tx
      .select({
        id: constituents.id,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
      })
      .from(constituents)
      .where(inArray(constituents.id, constituentIds)),
    tx
      .select({ donationId: receipts.donationId, status: receipts.status })
      .from(receipts)
      .where(inArray(receipts.donationId, donationIds))
      .orderBy(desc(receipts.createdAt)),
  ]);

  const constituentById = new Map(constituentRows.map((c) => [c.id, c]));
  const receiptByDonationId = new Map<string, (typeof receiptRows)[number]["status"]>();
  for (const r of receiptRows) {
    if (!receiptByDonationId.has(r.donationId)) {
      receiptByDonationId.set(r.donationId, r.status);
    }
  }

  return rows.map((d) => {
    const c = constituentById.get(d.constituentId) ?? null;
    return {
      ...d,
      constituent: c ? { firstName: c.firstName, lastName: c.lastName } : null,
      receiptStatus: receiptByDonationId.get(d.id) ?? null,
    };
  });
}

/** List donations for an organization with pagination and filtering */
export async function listDonations(orgId: string, query: ListDonationsQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;
  const where = listDonationsConditions(orgId, query);

  return withTenantContext(orgId, async (tx) => {
    const [data, countResult] = await Promise.all([
      tx
        .select()
        .from(donations)
        .where(where)
        .orderBy(sql`${donations.donatedAt} DESC`)
        .limit(perPage)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(donations).where(where),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    const pagination: Pagination = {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    };

    if (data.length === 0) {
      return { data: [], pagination };
    }

    const enriched = await enrichDonationRows(tx, data);
    return { data: enriched, pagination };
  });
}

/** Get a single donation by ID, including constituent info and allocations */
export async function getDonation(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [donation] = await tx
      .select()
      .from(donations)
      .where(and(eq(donations.id, id), eq(donations.orgId, orgId)));

    if (!donation) return null;

    const [constituent] = await tx
      .select({
        id: constituents.id,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
        email: constituents.email,
      })
      .from(constituents)
      .where(eq(constituents.id, donation.constituentId));

    const allocations = await tx
      .select({
        id: donationAllocations.id,
        fundId: donationAllocations.fundId,
        amountCents: donationAllocations.amountCents,
        fundName: funds.name,
      })
      .from(donationAllocations)
      .innerJoin(funds, eq(funds.id, donationAllocations.fundId))
      .where(eq(donationAllocations.donationId, id));

    return { ...donation, constituent: constituent ?? null, allocations };
  });
}

/** Get the generated receipt for a donation */
export async function getReceiptByDonation(orgId: string, donationId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.donationId, donationId),
          eq(receipts.orgId, orgId),
          eq(receipts.status, "generated"),
        ),
      );

    return receipt ?? null;
  });
}

/** Create a donation with optional allocations, emitting DonationCreated event transactionally.
 *  Returns null if the constituent does not exist within the tenant context. */
export async function createDonation(orgId: string, userId: string, input: DonationInput) {
  if (input.allocations && input.allocations.length > 0) {
    const allocSum = input.allocations.reduce((sum, a) => sum + a.amountCents, 0);
    if (allocSum !== input.amountCents) {
      throw new AllocationSumMismatchError(allocSum, input.amountCents);
    }
  }

  return withTenantContext(orgId, async (tx) => {
    // Verify constituent belongs to this tenant (FK check alone doesn't enforce RLS)
    const [constituent, tenant] = await Promise.all([
      tx
        .select({ id: constituents.id })
        .from(constituents)
        .where(and(eq(constituents.id, input.constituentId), eq(constituents.orgId, orgId))),
      tx.select({ baseCurrency: tenants.baseCurrency }).from(tenants).where(eq(tenants.id, orgId)),
    ]);

    if (!constituent[0]) return null;

    // Cross-tenant FK enforcement — issue #56 Data #1/#2. A Tenant B campaign
    // or fund id would otherwise pass the schema-level FK (uuid existence)
    // without being rejected, binding a donation to another tenant's records.
    await assertCampaignBelongsToOrg(tx, orgId, input.campaignId);
    await assertFundsBelongToOrg(tx, orgId, input.allocations);
    const currency = (input.currency ?? "EUR").toUpperCase();
    const baseCurrency = (tenant[0]?.baseCurrency ?? "EUR").toUpperCase();
    const exchangeRateService = new ExchangeRateService({ dbClient: tx });
    const convertedAmount = await exchangeRateService.convertAmountCents(
      input.amountCents,
      currency,
      baseCurrency,
    );

    const [donation] = await tx
      .insert(donations)
      .values({
        orgId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency,
        exchangeRate: convertedAmount.exchangeRate.toFixed(8),
        amountBaseCents: convertedAmount.amountBaseCents,
        campaignId: input.campaignId,
        paymentMethod: input.paymentMethod,
        paymentRef: input.paymentRef,
        donatedAt: input.donatedAt ? new Date(input.donatedAt) : new Date(),
        fiscalYear: input.fiscalYear,
      })
      .returning();

    // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns a row
    const donationId = donation!.id;

    if (input.allocations && input.allocations.length > 0) {
      await tx.insert(donationAllocations).values(
        input.allocations.map((a) => ({
          orgId,
          donationId,
          fundId: a.fundId,
          amountCents: a.amountCents,
        })),
      );
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.created",
      payload: {
        donationId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency,
        createdBy: userId,
      },
    });

    return donation;
  });
}

/** Update a donation and fully replace its allocations. */
export async function updateDonation(orgId: string, id: string, input: DonationUpdateInput) {
  if (input.allocations && input.allocations.length > 0) {
    const allocSum = input.allocations.reduce((sum, a) => sum + a.amountCents, 0);
    if (allocSum !== input.amountCents) {
      throw new AllocationSumMismatchError(allocSum, input.amountCents);
    }
  }

  return withTenantContext(orgId, async (tx) => {
    const { existing, constituent, tenant } = await loadDonationUpdateContext(
      tx,
      orgId,
      id,
      input.constituentId,
    );

    if (!existing || !constituent) {
      return null;
    }

    // Cross-tenant FK enforcement on update path too.
    await assertCampaignBelongsToOrg(tx, orgId, input.campaignId ?? null);
    await assertFundsBelongToOrg(tx, orgId, input.allocations);

    const currency = (input.currency ?? "EUR").toUpperCase();
    const baseCurrency = (tenant?.baseCurrency ?? "EUR").toUpperCase();
    const exchangeRateService = new ExchangeRateService({ dbClient: tx });
    const convertedAmount = await exchangeRateService.convertAmountCents(
      input.amountCents,
      currency,
      baseCurrency,
    );

    const [updated] = await tx
      .update(donations)
      .set({
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency,
        exchangeRate: convertedAmount.exchangeRate.toFixed(8),
        amountBaseCents: convertedAmount.amountBaseCents,
        campaignId: input.campaignId ?? null,
        paymentMethod: normalizeNullableString(input.paymentMethod) ?? null,
        paymentRef: normalizeNullableString(input.paymentRef) ?? null,
        donatedAt: input.donatedAt ? new Date(input.donatedAt) : undefined,
        fiscalYear: input.fiscalYear === undefined ? undefined : input.fiscalYear,
        updatedAt: new Date(),
      })
      .where(and(eq(donations.id, id), eq(donations.orgId, orgId)))
      .returning();

    await replaceDonationAllocations(tx, orgId, id, input.allocations);

    return updated ?? null;
  });
}

/** Delete a donation. Related allocations and receipts are removed by FK cascade. */
export async function deleteDonation(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [deleted] = await tx
      .delete(donations)
      .where(and(eq(donations.id, id), eq(donations.orgId, orgId)))
      .returning();

    return deleted ?? null;
  });
}
