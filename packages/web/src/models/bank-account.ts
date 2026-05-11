import type { Pagination } from "@/models/constituent";

/** Discriminator derived from the IBAN's IID range — never set by the operator. */
export type BankAccountIbanKind = "iban" | "qr_iban";

/** Currencies allowed by IG QR-bill v2.4. EUR + QRR is illegal (euroSIC). */
export type BankAccountCurrency = "CHF" | "EUR";

/**
 * Operator-configured Swiss operating account (Epic #318). IG QR-bill
 * v2.4 / v2.5 **structured address (S)** shape — combined-address (K)
 * is not supported.
 */
export interface BankAccount {
  id: string;
  orgId: string;
  holderName: string;
  /** IG `StrtNm` — street name only. */
  holderStreet: string;
  /** IG `BldgNb` — building / house number, nullable. */
  holderBuildingNumber: string | null;
  holderPostalCode: string;
  /** IG `TwnNm` — town / city. */
  holderTown: string;
  /** ISO 3166-1 alpha-2; restricted to CH or LI server-side. */
  holderCountryCode: string;
  /** Canonical form: uppercase, no spaces. */
  iban: string;
  ibanKind: BankAccountIbanKind;
  bic: string | null;
  bankName: string;
  currency: BankAccountCurrency;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BankAccountSortField = "bankName" | "currency" | "createdAt";
export type BankAccountSortOrder = "asc" | "desc";

export interface BankAccountListQuery {
  page?: number;
  perPage?: number;
  sort?: BankAccountSortField;
  order?: BankAccountSortOrder;
  includeDeleted?: boolean;
}

export interface BankAccountListResponse {
  data: BankAccount[];
  pagination: Pagination;
}

export interface BankAccountDetailResponse {
  data: BankAccount;
}

export interface BankAccountCreateInput {
  holderName: string;
  holderStreet: string;
  holderBuildingNumber?: string | null;
  holderPostalCode: string;
  holderTown: string;
  holderCountryCode?: string;
  iban: string;
  bic?: string | null;
  bankName: string;
  currency?: BankAccountCurrency;
}

export interface BankAccountUpdateInput {
  holderName?: string;
  holderStreet?: string;
  holderBuildingNumber?: string | null;
  holderPostalCode?: string;
  holderTown?: string;
  holderCountryCode?: string;
  bic?: string | null;
  bankName?: string;
  currency?: BankAccountCurrency;
}

export interface BankAccountUsage {
  swissQrReferenceCount: number;
  linkedCampaignCount: number;
}

export interface BankAccountUsageResponse {
  data: BankAccountUsage;
}
