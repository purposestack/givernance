/** Funds service — CRUD operations for tenant-scoped restricted and unrestricted funds */

import { bankAccounts, campaignFunds, donationAllocations, funds } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

/**
 * Single source of truth for the funds sort whitelist (issue #218).
 * Tuple drives both the route's TypeBox literal union and the service-
 * level `normalizeFundSort` fallback.
 */
export const FUND_SORT_FIELDS = ["name", "type", "createdAt"] as const;
export type FundSortField = (typeof FUND_SORT_FIELDS)[number];
export type FundSortOrder = "asc" | "desc";

export interface ListFundsQuery {
  page: number;
  perPage: number;
  sort?: string;
  order?: string;
}

/**
 * Defense-in-depth — see `donations/service.ts` `normalizeDonationSort`
 * for the rationale. Route-level TypeBox literal derived from the same
 * tuple is the contract; this fallback only kicks in if validation is
 * loosened.
 */
function normalizeFundSort(value: string | undefined): FundSortField {
  if (value && FUND_SORT_FIELDS.includes(value as FundSortField)) {
    return value as FundSortField;
  }
  return "createdAt";
}

function normalizeFundOrder(value: string | undefined): FundSortOrder {
  return value === "asc" ? "asc" : "desc";
}

/**
 * ORDER BY for `GET /funds`. `name` sort is case-insensitive (`lower(...)`)
 * to keep mixed-case fund names from splitting into two alphabets. Always
 * tiebreaks with `asc(id)` for deterministic offset pagination.
 */
function buildFundOrderBy(sort: FundSortField, order: FundSortOrder) {
  const dir = order === "asc" ? asc : desc;
  if (sort === "name") return [dir(sql`lower(${funds.name})`), asc(funds.id)];
  if (sort === "type") return [dir(funds.type), asc(funds.id)];
  return [dir(funds.createdAt), asc(funds.id)];
}

export interface FundInput {
  name: string;
  description?: string | null;
  type?: "restricted" | "unrestricted";
  bankAccountId?: string | null;
}

export interface UpdateFundInput {
  name?: string;
  description?: string | null;
  type?: "restricted" | "unrestricted";
  bankAccountId?: string | null;
}

export class FundConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundConflictError";
  }
}

/**
 * Raised when the caller provides a `bankAccountId` that does not exist
 * or does not belong to the same org (cross-org FK violation, ADR-019).
 */
export class BankAccountNotFoundError extends Error {
  constructor() {
    super("Bank account not found or does not belong to this organisation.");
    this.name = "BankAccountNotFoundError";
  }
}

/**
 * Raised when the caller provides a `bankAccountId` that is inactive.
 * Inactive accounts cannot be assigned to new or updated funds.
 */
export class BankAccountInactiveError extends Error {
  constructor() {
    super("The bank account is inactive and cannot be assigned to a fund.");
    this.name = "BankAccountInactiveError";
  }
}

/**
 * Raised when updating a fund's bank account would change the settlement
 * currency while donation allocations already exist for the fund.
 */
export class FundCurrencyChangedError extends Error {
  constructor() {
    super("Fund currency cannot change while donations are allocated to it.");
    this.name = "FundCurrencyChangedError";
  }
}

function normalizeDescription(description: string | null | undefined) {
  if (description === undefined) {
    return undefined;
  }

  return description === null || description.trim() === "" ? null : description;
}

/** Shape returned by read operations — includes the joined bank account fields. */
export interface FundRow {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  type: "restricted" | "unrestricted";
  bankAccountId: string | null;
  settlementCurrency: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** List funds for an organization with pagination. */
export async function listFunds(orgId: string, query: ListFundsQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;
  const sort = normalizeFundSort(query.sort);
  const order = normalizeFundOrder(query.order);

  return withTenantContext(orgId, async (tx) => {
    const where = eq(funds.orgId, orgId);

    const [rows, countResult] = await Promise.all([
      tx
        .select({
          id: funds.id,
          orgId: funds.orgId,
          name: funds.name,
          description: funds.description,
          type: funds.type,
          bankAccountId: funds.bankAccountId,
          settlementCurrency: bankAccounts.currency,
          createdAt: funds.createdAt,
          updatedAt: funds.updatedAt,
        })
        .from(funds)
        .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
        .where(where)
        .orderBy(...buildFundOrderBy(sort, order))
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

    const data: FundRow[] = rows.map((row) => ({
      ...row,
      settlementCurrency: row.settlementCurrency ?? null,
    }));

    return { data, pagination };
  });
}

/** Get a single fund by ID. */
export async function getFund(orgId: string, id: string): Promise<FundRow | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: funds.id,
        orgId: funds.orgId,
        name: funds.name,
        description: funds.description,
        type: funds.type,
        bankAccountId: funds.bankAccountId,
        settlementCurrency: bankAccounts.currency,
        createdAt: funds.createdAt,
        updatedAt: funds.updatedAt,
      })
      .from(funds)
      .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)));

    if (!row) return null;
    return { ...row, settlementCurrency: row.settlementCurrency ?? null };
  });
}

/**
 * Validate the given bankAccountId:
 *   1. Must exist in bank_accounts and belong to orgId.
 *   2. Must be active (is_active = true).
 *
 * Returns the bank account row (including currency) on success.
 * Throws BankAccountNotFoundError or BankAccountInactiveError on failure.
 */
async function validateBankAccount(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  bankAccountId: string,
) {
  const [account] = await tx
    .select({
      id: bankAccounts.id,
      orgId: bankAccounts.orgId,
      currency: bankAccounts.currency,
      isActive: bankAccounts.isActive,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.orgId, orgId)));

  if (!account) {
    throw new BankAccountNotFoundError();
  }

  if (!account.isActive) {
    throw new BankAccountInactiveError();
  }

  return account;
}

/** Create a fund. */
export async function createFund(orgId: string, input: FundInput): Promise<FundRow | null> {
  return withTenantContext(orgId, async (tx) => {
    // Validate bankAccountId if provided
    if (input.bankAccountId != null) {
      await validateBankAccount(tx, orgId, input.bankAccountId);
    }

    const [fund] = await tx
      .insert(funds)
      .values({
        orgId,
        name: input.name,
        description: normalizeDescription(input.description) ?? null,
        type: input.type ?? "unrestricted",
        bankAccountId: input.bankAccountId ?? null,
      })
      .returning();

    if (!fund) return null;

    // Re-fetch with the join to get settlementCurrency
    return getFundInTx(tx, orgId, fund.id);
  });
}

/**
 * Validates a bank account assignment change for a fund update and blocks
 * currency flips when donation allocations already exist.
 *
 * Throws BankAccountNotFoundError, BankAccountInactiveError, or
 * FundCurrencyChangedError as appropriate. No-ops when `newBankAccountId`
 * is `undefined` (field not being updated).
 */
async function checkBankAccountChange(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  fundId: string,
  newBankAccountId: string | null | undefined,
  currentBankAccountId: string | null,
  currentCurrency: string | null,
) {
  if (newBankAccountId === undefined) return;

  let newCurrency: string | null = null;
  if (newBankAccountId != null) {
    const account = await validateBankAccount(tx, orgId, newBankAccountId);
    newCurrency = account.currency;
  }

  const currencyChanging =
    newBankAccountId !== currentBankAccountId &&
    (currentCurrency !== null || newCurrency !== null) &&
    currentCurrency !== newCurrency;

  if (!currencyChanging) return;

  const [allocation] = await tx
    .select({ id: donationAllocations.id })
    .from(donationAllocations)
    .where(and(eq(donationAllocations.orgId, orgId), eq(donationAllocations.fundId, fundId)))
    .limit(1);

  if (allocation) {
    throw new FundCurrencyChangedError();
  }
}

/** Update a fund. */
export async function updateFund(
  orgId: string,
  id: string,
  input: UpdateFundInput,
): Promise<FundRow | null> {
  return withTenantContext(orgId, async (tx) => {
    // Fetch the existing fund (with current bank account) to check existence and currency
    const [existing] = await tx
      .select({
        id: funds.id,
        bankAccountId: funds.bankAccountId,
        currentCurrency: bankAccounts.currency,
      })
      .from(funds)
      .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)));

    if (!existing) {
      return null;
    }

    await checkBankAccountChange(
      tx,
      orgId,
      id,
      input.bankAccountId,
      existing.bankAccountId ?? null,
      existing.currentCurrency ?? null,
    );

    const [updated] = await tx
      .update(funds)
      .set({
        name: input.name,
        description: normalizeDescription(input.description),
        type: input.type,
        bankAccountId:
          input.bankAccountId !== undefined ? (input.bankAccountId ?? null) : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(funds.id, id), eq(funds.orgId, orgId)))
      .returning();

    if (!updated) return null;

    return getFundInTx(tx, orgId, updated.id);
  });
}

/**
 * Internal helper — fetches a fund row with its LEFT JOIN on bank_accounts
 * within an already-open transaction context.
 */
async function getFundInTx(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  id: string,
): Promise<FundRow | null> {
  const [row] = await tx
    .select({
      id: funds.id,
      orgId: funds.orgId,
      name: funds.name,
      description: funds.description,
      type: funds.type,
      bankAccountId: funds.bankAccountId,
      settlementCurrency: bankAccounts.currency,
      createdAt: funds.createdAt,
      updatedAt: funds.updatedAt,
    })
    .from(funds)
    .leftJoin(bankAccounts, eq(funds.bankAccountId, bankAccounts.id))
    .where(and(eq(funds.id, id), eq(funds.orgId, orgId)));

  if (!row) return null;
  return { ...row, settlementCurrency: row.settlementCurrency ?? null };
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

    // deleteFund returns the plain funds row (no JOIN needed — the account is
    // no longer meaningful after deletion).
    if (!deleted) return null;
    return {
      id: deleted.id,
      orgId: deleted.orgId,
      name: deleted.name,
      description: deleted.description,
      type: deleted.type,
      bankAccountId: deleted.bankAccountId ?? null,
      settlementCurrency: null,
      createdAt: deleted.createdAt,
      updatedAt: deleted.updatedAt,
    } satisfies FundRow;
  });
}
