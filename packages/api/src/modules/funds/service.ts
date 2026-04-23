/** Funds service — CRUD operations for tenant-scoped restricted and unrestricted funds */

import { campaignFunds, donationAllocations, funds } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface ListFundsQuery {
  page: number;
  perPage: number;
}

export interface FundInput {
  name: string;
  description?: string | null;
  type?: "restricted" | "unrestricted";
}

export interface UpdateFundInput {
  name?: string;
  description?: string | null;
  type?: "restricted" | "unrestricted";
}

export class FundConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundConflictError";
  }
}

function normalizeDescription(description: string | null | undefined) {
  if (description === undefined) {
    return undefined;
  }

  return description === null || description.trim() === "" ? null : description;
}

/** List funds for an organization with pagination. */
export async function listFunds(orgId: string, query: ListFundsQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const where = eq(funds.orgId, orgId);

    const [data, countResult] = await Promise.all([
      tx
        .select()
        .from(funds)
        .where(where)
        .orderBy(sql`${funds.createdAt} DESC`)
        .limit(perPage)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(funds).where(where),
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

/** Get a single fund by ID. */
export async function getFund(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [fund] = await tx
      .select()
      .from(funds)
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)));

    return fund ?? null;
  });
}

/** Create a fund. */
export async function createFund(orgId: string, input: FundInput) {
  return withTenantContext(orgId, async (tx) => {
    const [fund] = await tx
      .insert(funds)
      .values({
        orgId,
        name: input.name,
        description: normalizeDescription(input.description) ?? null,
        type: input.type ?? "unrestricted",
      })
      .returning();

    return fund ?? null;
  });
}

/** Update a fund. */
export async function updateFund(orgId: string, id: string, input: UpdateFundInput) {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select({ id: funds.id })
      .from(funds)
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)));

    if (!existing) {
      return null;
    }

    const [updated] = await tx
      .update(funds)
      .set({
        name: input.name,
        description: normalizeDescription(input.description),
        type: input.type,
        updatedAt: new Date(),
      })
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)))
      .returning();

    return updated ?? null;
  });
}

/** Delete a fund unless it is still referenced by donation allocations. */
export async function deleteFund(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(funds)
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)));

    if (!existing) {
      return null;
    }

    const [allocation] = await tx
      .select({ id: donationAllocations.id })
      .from(donationAllocations)
      .where(and(eq(donationAllocations.orgId, orgId), eq(donationAllocations.fundId, id)))
      .limit(1);

    if (allocation) {
      throw new FundConflictError("Fund cannot be deleted while donation allocations reference it");
    }

    await tx
      .delete(campaignFunds)
      .where(and(eq(campaignFunds.orgId, orgId), eq(campaignFunds.fundId, id)));

    const [deleted] = await tx
      .delete(funds)
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)))
      .returning();

    return deleted ?? null;
  });
}
