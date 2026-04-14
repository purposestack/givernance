/** Donations service — business logic for donation operations */

import {
  constituents,
  donationAllocations,
  donations,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

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

/** List donations for an organization with pagination and filtering */
export async function listDonations(orgId: string, query: ListDonationsQuery) {
  const { page, perPage, dateFrom, dateTo, amountMin, amountMax, constituentId, campaignId } =
    query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const conditions = [eq(donations.orgId, orgId)];

    if (dateFrom) {
      conditions.push(gte(donations.donatedAt, new Date(dateFrom)));
    }
    if (dateTo) {
      conditions.push(lte(donations.donatedAt, new Date(dateTo)));
    }
    if (amountMin !== undefined) {
      conditions.push(gte(donations.amountCents, amountMin));
    }
    if (amountMax !== undefined) {
      conditions.push(lte(donations.amountCents, amountMax));
    }
    if (constituentId) {
      conditions.push(eq(donations.constituentId, constituentId));
    }
    if (campaignId) {
      conditions.push(eq(donations.campaignId, campaignId));
    }

    const where = and(...conditions);

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

    return { data, pagination };
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

/** Create a donation with optional allocations, emitting DonationCreated event transactionally */
export async function createDonation(orgId: string, userId: string, input: DonationInput) {
  return withTenantContext(orgId, async (tx) => {
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
