/**
 * Bank Accounts service — tenant-scoped CRUD for Swiss QR-bill operating
 * accounts (Epic #318, PR #2).
 *
 * Audit log is captured automatically by the `audit` plugin on every
 * mutating request — this service writes no `audit_logs` rows itself.
 *
 * Soft-delete contract: a bank account that has ever issued a
 * `swiss_qr_references` row cannot be hard-deleted (FK with ON DELETE
 * RESTRICT). `deleteBankAccount` is therefore a soft-delete: it sets
 * `deleted_at = NOW()` and `campaigns.bank_account_id` cascades to NULL
 * via the campaigns-side FK (ON DELETE SET NULL). The partial unique
 * index on `(org_id, iban) WHERE deleted_at IS NULL` lets the same IBAN
 * be re-added after soft-delete (the old row stays for audit).
 */

import {
  type BankAccount,
  bankAccounts,
  campaigns,
  swissQrReferences,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { classifyIban } from "@givernance/shared/validators";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

/** Tuple drives both the route's TypeBox literal union + this fallback. */
export const BANK_ACCOUNT_SORT_FIELDS = ["bankName", "currency", "createdAt"] as const;
export type BankAccountSortField = (typeof BANK_ACCOUNT_SORT_FIELDS)[number];
export type BankAccountSortOrder = "asc" | "desc";

export interface ListBankAccountsQuery {
  page: number;
  perPage: number;
  sort?: string;
  order?: string;
  /** Show soft-deleted accounts too (admin audit surface; default false). */
  includeDeleted?: boolean;
}

/** Defense-in-depth — see donations/service.ts for the rationale. */
function normalizeSort(value: string | undefined): BankAccountSortField {
  if (value && BANK_ACCOUNT_SORT_FIELDS.includes(value as BankAccountSortField)) {
    return value as BankAccountSortField;
  }
  return "createdAt";
}

function normalizeOrder(value: string | undefined): BankAccountSortOrder {
  return value === "asc" ? "asc" : "desc";
}

function buildOrderBy(sort: BankAccountSortField, order: BankAccountSortOrder) {
  const dir = order === "asc" ? asc : desc;
  if (sort === "bankName") return [dir(sql`lower(${bankAccounts.bankName})`), asc(bankAccounts.id)];
  if (sort === "currency") return [dir(bankAccounts.currency), asc(bankAccounts.id)];
  return [dir(bankAccounts.createdAt), asc(bankAccounts.id)];
}

/**
 * Canonicalise an IBAN at the service boundary: strip whitespace,
 * uppercase. The DB has a CHECK constraint enforcing `^[A-Z0-9]+$`, so
 * persisting anything else would fail the migration's last-line-of-defence.
 */
function canonicaliseIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/** Canonicalise BIC the same way. */
function canonicaliseBic(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.replace(/\s+/g, "").toUpperCase();
  return trimmed === "" ? null : trimmed;
}

export interface CreateBankAccountInput {
  holderName: string;
  holderStreet: string;
  holderBuildingNumber?: string | null;
  holderPostalCode: string;
  holderTown: string;
  holderCountryCode?: string;
  iban: string;
  bic?: string | null;
  bankName: string;
  currency?: "CHF" | "EUR";
}

export interface UpdateBankAccountInput {
  holderName?: string;
  holderStreet?: string;
  holderBuildingNumber?: string | null;
  holderPostalCode?: string;
  holderTown?: string;
  holderCountryCode?: string;
  bic?: string | null;
  bankName?: string;
  currency?: "CHF" | "EUR";
}

export class BankAccountConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankAccountConflictError";
  }
}

export class BankAccountValidationError extends Error {
  public readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "BankAccountValidationError";
  }
}

/**
 * Resolve the `iban_kind` discriminator from the IBAN itself — operators
 * never type "qr_iban" vs "iban" by hand, the API derives it from the
 * IID range (30000–31999 for QR-IBAN).
 */
function deriveIbanKind(iban: string): "iban" | "qr_iban" {
  return classifyIban(iban) === "qr_iban" ? "qr_iban" : "iban";
}

function validateCurrencyVsKind(currency: "CHF" | "EUR", ibanKind: "iban" | "qr_iban"): void {
  // EUR + QRR is illegal under IG QR-bill v2.4 (euroSIC discontinuation).
  // A QR-IBAN forces QRR for the reference type, so EUR + QR-IBAN is the
  // exact pathological combination we block here at create-time, with the
  // same error code surfaced by the campaign readiness gate.
  if (currency === "EUR" && ibanKind === "qr_iban") {
    throw new BankAccountValidationError(
      "currency",
      "EUR is illegal with a QR-IBAN (which forces QRR — banned under IG QR-bill v2.4 since euroSIC was discontinued). Use a regular IBAN with EUR + SCOR, or switch the currency to CHF.",
    );
  }
}

/** List bank accounts for an org with pagination. */
export async function listBankAccounts(orgId: string, query: ListBankAccountsQuery) {
  const { page, perPage, includeDeleted = false } = query;
  const offset = (page - 1) * perPage;
  const sort = normalizeSort(query.sort);
  const order = normalizeOrder(query.order);

  return withTenantContext(orgId, async (tx) => {
    const where = includeDeleted
      ? eq(bankAccounts.orgId, orgId)
      : and(eq(bankAccounts.orgId, orgId), isNull(bankAccounts.deletedAt));

    const [data, countResult] = await Promise.all([
      tx
        .select()
        .from(bankAccounts)
        .where(where)
        .orderBy(...buildOrderBy(sort, order))
        .limit(perPage)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(bankAccounts).where(where),
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

/** Get a single bank account by ID. Returns null if not found OR soft-deleted (callers wanting the soft-deleted row use `includeDeleted=true`). */
export async function getBankAccount(
  orgId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<BankAccount | null> {
  return withTenantContext(orgId, async (tx) => {
    const conditions = options.includeDeleted
      ? and(eq(bankAccounts.id, id), eq(bankAccounts.orgId, orgId))
      : and(eq(bankAccounts.id, id), eq(bankAccounts.orgId, orgId), isNull(bankAccounts.deletedAt));

    const [row] = await tx.select().from(bankAccounts).where(conditions);
    return row ?? null;
  });
}

/** Create a bank account. Throws `BankAccountValidationError` on illegal payloads, `BankAccountConflictError` on duplicate IBAN. */
export async function createBankAccount(
  orgId: string,
  input: CreateBankAccountInput,
): Promise<BankAccount> {
  const iban = canonicaliseIban(input.iban);
  if (classifyIban(iban) === "invalid") {
    throw new BankAccountValidationError("iban", "IBAN failed mod-97 / format validation.");
  }
  const country = iban.slice(0, 2);
  if (country !== "CH" && country !== "LI") {
    throw new BankAccountValidationError(
      "iban",
      `Swiss QR-bill scope: only CH and LI IBANs are supported (got ${country}).`,
    );
  }

  const ibanKind = deriveIbanKind(iban);
  const currency = input.currency ?? "CHF";
  validateCurrencyVsKind(currency, ibanKind);

  const holderCountryCode = (input.holderCountryCode ?? "CH").toUpperCase();
  if (!["CH", "LI"].includes(holderCountryCode)) {
    throw new BankAccountValidationError(
      "holderCountryCode",
      "Holder country must be CH or LI (IG QR-bill scope).",
    );
  }

  const bic = canonicaliseBic(input.bic);
  if (bic && ![8, 11].includes(bic.length)) {
    throw new BankAccountValidationError(
      "bic",
      `BIC must be exactly 8 or 11 characters when present (ISO 9362). Got ${bic.length}.`,
    );
  }

  return withTenantContext(orgId, async (tx) => {
    // Surface duplicate-IBAN as a typed conflict rather than letting the
    // DB unique-violation bubble up as a 500.
    const [existingByIban] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.orgId, orgId),
          eq(bankAccounts.iban, iban),
          isNull(bankAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (existingByIban) {
      throw new BankAccountConflictError(
        "A bank account with this IBAN already exists for this organisation.",
      );
    }

    const [row] = await tx
      .insert(bankAccounts)
      .values({
        orgId,
        holderName: input.holderName,
        holderStreet: input.holderStreet,
        holderBuildingNumber:
          input.holderBuildingNumber == null || input.holderBuildingNumber === ""
            ? null
            : input.holderBuildingNumber,
        holderPostalCode: input.holderPostalCode,
        holderTown: input.holderTown,
        holderCountryCode,
        iban,
        ibanKind,
        bic,
        bankName: input.bankName,
        currency,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to insert bank account");
    }
    return row;
  });
}

/**
 * Update a bank account. The IBAN itself is **immutable** post-create —
 * the operator must soft-delete and re-create if they need to change it
 * (financial-record integrity: a changed IBAN on the same row would
 * silently re-attribute every prior `swiss_qr_references` and
 * `camt_statements` import).
 */
/**
 * Pre-flight validation for `updateBankAccount`. Extracted so the main
 * service body stays under the cognitive-complexity ceiling (biome rule).
 */
function validateUpdateBankAccountInput(input: UpdateBankAccountInput): void {
  if (input.bic !== undefined) {
    const bic = canonicaliseBic(input.bic);
    if (bic && ![8, 11].includes(bic.length)) {
      throw new BankAccountValidationError(
        "bic",
        `BIC must be exactly 8 or 11 characters when present (ISO 9362). Got ${bic.length}.`,
      );
    }
  }
  if (input.holderCountryCode !== undefined) {
    const cc = input.holderCountryCode.toUpperCase();
    if (!["CH", "LI"].includes(cc)) {
      throw new BankAccountValidationError(
        "holderCountryCode",
        "Holder country must be CH or LI (IG QR-bill scope).",
      );
    }
  }
}

/**
 * Build the partial-update patch from the input. Pure function — no IO.
 * Extracted to keep `updateBankAccount` under the cognitive-complexity
 * ceiling. The `updatedAt` is always set on the patch so the
 * `audit_logs.created_at` correlation works even when only one field
 * changes.
 */
function buildUpdatePatch(input: UpdateBankAccountInput) {
  const patch: Partial<typeof bankAccounts.$inferInsert> = { updatedAt: new Date() };
  if (input.holderName !== undefined) patch.holderName = input.holderName;
  if (input.holderStreet !== undefined) patch.holderStreet = input.holderStreet;
  if (input.holderBuildingNumber !== undefined) {
    patch.holderBuildingNumber =
      input.holderBuildingNumber === null || input.holderBuildingNumber === ""
        ? null
        : input.holderBuildingNumber;
  }
  if (input.holderPostalCode !== undefined) patch.holderPostalCode = input.holderPostalCode;
  if (input.holderTown !== undefined) patch.holderTown = input.holderTown;
  if (input.holderCountryCode !== undefined) {
    patch.holderCountryCode = input.holderCountryCode.toUpperCase();
  }
  if (input.bic !== undefined) patch.bic = canonicaliseBic(input.bic);
  if (input.bankName !== undefined) patch.bankName = input.bankName;
  if (input.currency !== undefined) patch.currency = input.currency;
  return patch;
}

export async function updateBankAccount(
  orgId: string,
  id: string,
  input: UpdateBankAccountInput,
): Promise<BankAccount | null> {
  validateUpdateBankAccountInput(input);

  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(eq(bankAccounts.id, id), eq(bankAccounts.orgId, orgId), isNull(bankAccounts.deletedAt)),
      );

    if (!existing) {
      return null;
    }

    // Currency change is constrained by the IBAN's kind (immutable),
    // so the same EUR+QR-IBAN combo we block at create-time fires here.
    if (input.currency && input.currency !== existing.currency) {
      validateCurrencyVsKind(input.currency, existing.ibanKind);
    }

    const patch = buildUpdatePatch(input);

    const [updated] = await tx
      .update(bankAccounts)
      .set(patch)
      .where(and(eq(bankAccounts.id, id), eq(bankAccounts.orgId, orgId)))
      .returning();

    return updated ?? null;
  });
}

/**
 * Soft-delete a bank account. Sets `deleted_at = NOW()`; the FK on
 * `swiss_qr_references.bank_account_id` is ON DELETE RESTRICT so a hard
 * delete is intentionally impossible once a single QR-bill has been
 * issued (financial record retention). Linked campaigns degrade
 * gracefully via the `campaigns.bank_account_id` ON DELETE SET NULL FK.
 *
 * Returns the soft-deleted row, or null if already deleted / not found.
 */
export async function deleteBankAccount(orgId: string, id: string): Promise<BankAccount | null> {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(eq(bankAccounts.id, id), eq(bankAccounts.orgId, orgId), isNull(bankAccounts.deletedAt)),
      );

    if (!existing) {
      return null;
    }

    // Unlink campaigns (cascade is automatic via the campaigns FK,
    // but doing it explicitly inside the same transaction keeps the
    // audit story atomic — the campaign UPDATE lands in the same TX
    // as the bank-account UPDATE, so the audit-log relay can correlate
    // them via `created_at`).
    await tx
      .update(campaigns)
      .set({ bankAccountId: null, updatedAt: new Date() })
      .where(and(eq(campaigns.orgId, orgId), eq(campaigns.bankAccountId, id)));

    const [deleted] = await tx
      .update(bankAccounts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bankAccounts.id, id), eq(bankAccounts.orgId, orgId)))
      .returning();

    return deleted ?? null;
  });
}

/**
 * Return basic usage stats for a bank account — used by the UI to
 * surface "this account has issued N QR-bills" before the operator
 * confirms a soft-delete.
 */
export async function getBankAccountUsage(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [refCount] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(swissQrReferences)
      .where(and(eq(swissQrReferences.orgId, orgId), eq(swissQrReferences.bankAccountId, id)));

    const [campaignCount] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(and(eq(campaigns.orgId, orgId), eq(campaigns.bankAccountId, id)));

    return {
      swissQrReferenceCount: Number(refCount?.count ?? 0),
      linkedCampaignCount: Number(campaignCount?.count ?? 0),
    };
  });
}
