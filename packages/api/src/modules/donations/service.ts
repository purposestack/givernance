/** Donations service — business logic for donation operations */

import {
  constituents,
  donationAllocations,
  donations,
  outboxEvents,
  receipts,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

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
      .select()
      .from(donationAllocations)
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
    const [constituent] = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(and(eq(constituents.id, input.constituentId), eq(constituents.orgId, orgId)));

    if (!constituent) return null;

    const [donation] = await tx
      .insert(donations)
      .values({
        orgId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency: input.currency ?? "EUR",
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
        currency: input.currency ?? "EUR",
        createdBy: userId,
      },
    });

    return donation;
  });
}
