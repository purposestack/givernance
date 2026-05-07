/**
 * Swiss QR-bill foundation schema (Epic #318).
 *
 * Five tenant-scoped tables that wire the Swiss postal-donation rail
 * onto the existing campaign + donation graph:
 *
 *   - `bank_accounts`              — IBAN/QR-IBAN holders configured
 *                                    in `Settings → Bank Accounts`,
 *                                    one per Swiss operating account.
 *   - `swiss_qr_references`        — per-recipient QRR/SCOR minted at
 *                                    postal-export time, sibling to
 *                                    `campaign_qr_codes`.
 *   - `camt_statements`            — uploaded ISO 20022 camt.053 file
 *                                    metadata (raw XML lives in S3).
 *   - `camt_credit_entries`        — one row per `Ntry` observed in a
 *                                    statement, idempotent on
 *                                    `(statement_id, AcctSvcrRef)`.
 *   - `camt_unreconciled_entries`  — manual-review queue for credit
 *                                    entries the reconciler couldn't
 *                                    auto-match (no QR ref / format /
 *                                    foreign IBAN / orphan reversal).
 *
 * Companion migration: `0044_swiss_qr_bill_foundation.sql`. The
 * partial unique index for retry-idempotency on
 * `swiss_qr_references (export_id, COALESCE(constituent_id, '00…'))`
 * is declared in the migration directly (Drizzle Kit doesn't model
 * COALESCE-based partial indexes) — the unconditional unique here
 * gives type-side parity for the query builder.
 *
 * RLS: every table is tenant-scoped via the standard
 * `tenant_isolation` policy keyed on `org_id`. See migration.
 */

import {
  bigint,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { campaignPostalExports, campaigns, constituents, donations, tenants, users } from "./index";

// ─── Enums ──────────────────────────────────────────────────────────────────

/** IBAN classification: regular IBAN or QR-IBAN (IID 30000-31999). */
export const BANK_ACCOUNT_IBAN_KIND_VALUES = ["iban", "qr_iban"] as const;
export type BankAccountIbanKind = (typeof BANK_ACCOUNT_IBAN_KIND_VALUES)[number];

export const bankAccountIbanKindEnum = pgEnum("bank_account_iban_kind", [
  ...BANK_ACCOUNT_IBAN_KIND_VALUES,
]);

/** Operating-account currency. CHF default; EUR allowed (SCOR-only — EUR+QRR is illegal under IG v2.4). */
export const BANK_ACCOUNT_CURRENCY_VALUES = ["CHF", "EUR"] as const;
export type BankAccountCurrency = (typeof BANK_ACCOUNT_CURRENCY_VALUES)[number];

export const bankAccountCurrencyEnum = pgEnum("bank_account_currency", [
  ...BANK_ACCOUNT_CURRENCY_VALUES,
]);

/** Swiss QR-bill reference type: 27-digit QRR (mod-10) or RF-prefixed SCOR (ISO 11649). */
export const SWISS_QR_REFERENCE_TYPE_VALUES = ["qrr", "scor"] as const;
export type SwissQrReferenceType = (typeof SWISS_QR_REFERENCE_TYPE_VALUES)[number];

export const swissQrReferenceTypeEnum = pgEnum("swiss_qr_reference_type", [
  ...SWISS_QR_REFERENCE_TYPE_VALUES,
]);

/** camt.053 import lifecycle. `pending` → `processing` → `processed | failed`. */
export const CAMT_STATEMENT_STATUS_VALUES = [
  "pending",
  "processing",
  "processed",
  "failed",
] as const;
export type CamtStatementStatus = (typeof CAMT_STATEMENT_STATUS_VALUES)[number];

export const camtStatementStatusEnum = pgEnum("camt_statement_status", [
  ...CAMT_STATEMENT_STATUS_VALUES,
]);

/** Reason a camt.053 credit landed in the manual-review queue. */
export const CAMT_UNRECONCILED_REASON_VALUES = [
  "no_match",
  "partial_match",
  "invalid_ref",
  "foreign_iban",
  "orphan_reversal",
] as const;
export type CamtUnreconciledReason = (typeof CAMT_UNRECONCILED_REASON_VALUES)[number];

export const camtUnreconciledReasonEnum = pgEnum("camt_unreconciled_reason", [
  ...CAMT_UNRECONCILED_REASON_VALUES,
]);

/** Lifecycle of a manual-review row. `pending` → `resolved | written_off`. */
export const CAMT_UNRECONCILED_STATUS_VALUES = ["pending", "resolved", "written_off"] as const;
export type CamtUnreconciledStatus = (typeof CAMT_UNRECONCILED_STATUS_VALUES)[number];

export const camtUnreconciledStatusEnum = pgEnum("camt_unreconciled_status", [
  ...CAMT_UNRECONCILED_STATUS_VALUES,
]);

/** Per-campaign reference-mode override. `auto` derives from `bank_accounts.iban_kind`. */
export const CAMPAIGN_QR_REFERENCE_MODE_VALUES = ["auto", "qrr", "scor"] as const;
export type CampaignQrReferenceMode = (typeof CAMPAIGN_QR_REFERENCE_MODE_VALUES)[number];

export const campaignQrReferenceModeEnum = pgEnum("campaign_qr_reference_mode", [
  ...CAMPAIGN_QR_REFERENCE_MODE_VALUES,
]);

/** Origin rail for a donation row. Distinguishes Stripe-rail from camt.053-rail from manual entry. */
export const DONATION_PAYMENT_SOURCE_VALUES = ["stripe", "camt053", "manual"] as const;
export type DonationPaymentSource = (typeof DONATION_PAYMENT_SOURCE_VALUES)[number];

export const donationPaymentSourceEnum = pgEnum("donation_payment_source", [
  ...DONATION_PAYMENT_SOURCE_VALUES,
]);

// ─── bank_accounts ──────────────────────────────────────────────────────────

/**
 * Swiss bank account configured by an org_admin in
 * `Settings → Bank Accounts`. Holds the data printed on every QR-bill
 * (holder name + address + IBAN + currency) and acts as the join target
 * for camt.053 imports — every uploaded statement must reference an
 * IBAN registered here, or the worker rejects the file (foreign-IBAN
 * safety, §7).
 *
 * Field caps mirror the QR-bill IG v2.4 string limits exactly so the
 * renderer never has to truncate: holder_name ≤ 70, address_line1 ≤ 70,
 * address_line2 ≤ 16, postal_code ≤ 16, city ≤ 35, country exactly 2.
 *
 * Soft-delete (`deleted_at`): once a bank account has issued a single
 * `swiss_qr_references` row, it cannot be hard-deleted (FK with
 * `ON DELETE RESTRICT`) — financial-record retention. Removing it from
 * the UI sets `deleted_at` and degrades any linked campaign back to
 * "no QR-bill" mode (`campaigns.bank_account_id` becomes NULL via
 * ON DELETE SET NULL on the FK declared in the migration).
 */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    holderName: varchar("holder_name", { length: 70 }).notNull(),
    holderAddressLine1: varchar("holder_address_line1", { length: 70 }).notNull(),
    holderAddressLine2: varchar("holder_address_line2", { length: 16 }),
    holderPostalCode: varchar("holder_postal_code", { length: 16 }).notNull(),
    holderCity: varchar("holder_city", { length: 35 }).notNull(),
    /** ISO 3166-1 alpha-2 — CHECK in migration restricts to CH or LI (IG QR-bill scope). */
    holderCountryCode: varchar("holder_country_code", { length: 2 }).notNull().default("CH"),
    /**
     * Stored canonical (no-spaces, uppercase). VARCHAR(34) covers any
     * IBAN; CH/LI are 21 chars. Validated mod-97 + country at the API
     * boundary by `validators/iban.ts::isValidIban`.
     */
    iban: varchar("iban", { length: 34 }).notNull(),
    ibanKind: bankAccountIbanKindEnum("iban_kind").notNull(),
    /** SWIFT/BIC — 8 or 11 chars; nullable because not always known by the operator. */
    bic: varchar("bic", { length: 11 }),
    /** Bank display name (e.g. "PostFinance", "UBS Switzerland AG") — printed on the slip. */
    bankName: varchar("bank_name", { length: 100 }).notNull(),
    currency: bankAccountCurrencyEnum("currency").notNull().default("CHF"),
    /**
     * Soft-delete marker. The matching unique index on `(org_id, iban)`
     * is partial — `WHERE deleted_at IS NULL` — so the same IBAN can be
     * re-added after a soft-delete. The Drizzle-side unique here is
     * unconditional for type parity; the migration declares the partial
     * predicate.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("bank_accounts_org_idx").on(table.orgId),
    unique("bank_accounts_org_iban_uniq").on(table.orgId, table.iban),
  ],
);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;

// ─── swiss_qr_references ────────────────────────────────────────────────────

/**
 * Per-recipient QRR or SCOR reference minted at postal-export time.
 * Sibling to `campaign_qr_codes` — the two rows are 1:1-paired in the
 * worker and share their export lifecycle, but live in separate tables
 * because their alphabets, security models, uniqueness scopes and
 * retention stories diverge (see Epic §2 "Why a separate table…").
 *
 * Idempotency contract:
 *   - `(org_id, bank_account_id, reference) UNIQUE` — the reference IS
 *     the universal donor handle; cannot collide within a bank account.
 *   - `(export_id, constituent_id) UNIQUE` (partial in migration with
 *     COALESCE for door-drop V2 NULL recipients) — a Kamal retry of the
 *     same export reuses the existing row instead of minting twice.
 *
 * `bank_account_id` ON DELETE RESTRICT: a bank account that has ever
 * issued a reference cannot be hard-deleted; soft-delete still works
 * because `deleted_at` lives on `bank_accounts` itself.
 */
export const swissQrReferences = pgTable(
  "swiss_qr_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    /** Nullable because door-drop V2 mints one ref per export with no recipient. */
    constituentId: uuid("constituent_id").references(() => constituents.id, {
      onDelete: "set null",
    }),
    /** Backlink for retry-idempotency — see file header. */
    exportId: uuid("export_id")
      .notNull()
      .references(() => campaignPostalExports.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    referenceType: swissQrReferenceTypeEnum("reference_type").notNull(),
    /** 27 digits (QRR) or `RF` + ≤23 alnum (SCOR) — capped at 40 for headroom. */
    reference: varchar("reference", { length: 40 }).notNull(),
    /** 0 = donor-fills the amount in their e-banking app (the default Swiss UX). */
    amountCents: bigint("amount_cents", { mode: "number" }).notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("swiss_qr_references_org_idx").on(table.orgId),
    index("swiss_qr_references_campaign_idx").on(table.campaignId),
    index("swiss_qr_references_export_idx").on(table.exportId),
    unique("swiss_qr_references_org_bank_ref_uniq").on(
      table.orgId,
      table.bankAccountId,
      table.reference,
    ),
    // Type-side parity for the (export_id, constituent_id) uniqueness —
    // the migration overrides with a COALESCE-based partial unique so
    // door-drop V2 (NULL constituent_id) still de-duplicates on retry.
    unique("swiss_qr_references_export_constituent_uniq").on(table.exportId, table.constituentId),
  ],
);

export type SwissQrReference = typeof swissQrReferences.$inferSelect;
export type NewSwissQrReference = typeof swissQrReferences.$inferInsert;

// ─── camt_statements ────────────────────────────────────────────────────────

/**
 * Uploaded camt.053 file metadata. The raw XML stays in the private
 * `bank-statements` S3 bucket (10-yr Swiss CO Art. 958f retention) at
 * `{org_id}/camt053/{yyyy}/{mm}/{filename}`. This row is the index +
 * idempotency key + status surface for the worker.
 *
 * `(org_id, msg_id) UNIQUE`: re-uploading the same file (same
 * `GrpHdr.MsgId`) is a deliberate no-op rather than a duplicate import.
 *
 * `bank_account_id` ON DELETE RESTRICT: the audit story "show me every
 * statement ever imported for this account" must outlive the soft-
 * delete of the bank account itself (financial record).
 */
export const camtStatements = pgTable(
  "camt_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    s3Path: varchar("s3_path", { length: 500 }).notNull(),
    /** ISO 20022 `GrpHdr.MsgId` — file-level idempotency key. */
    msgId: varchar("msg_id", { length: 255 }).notNull(),
    statementFrom: date("statement_from"),
    statementTo: date("statement_to"),
    totalCredits: integer("total_credits").notNull().default(0),
    matchedCredits: integer("matched_credits").notNull().default(0),
    unmatchedCredits: integer("unmatched_credits").notNull().default(0),
    status: camtStatementStatusEnum("status").notNull().default("pending"),
    /** Captured error message on terminal failure; surfaced as a generic toast in the UI. */
    error: text("error"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("camt_statements_org_idx").on(table.orgId),
    index("camt_statements_bank_account_idx").on(table.bankAccountId),
    index("camt_statements_status_idx").on(table.status),
    unique("camt_statements_org_msg_id_uniq").on(table.orgId, table.msgId),
  ],
);

export type CamtStatement = typeof camtStatements.$inferSelect;
export type NewCamtStatement = typeof camtStatements.$inferInsert;

// ─── camt_credit_entries ────────────────────────────────────────────────────

/**
 * One row per camt.053 `Ntry` we observed (always inserted, matched or
 * not). Idempotent at entry level on `(org_id, statement_id,
 * acct_svcr_ref)`: some banks reuse `AcctSvcrRef` across related
 * entries, hence the secondary `end_to_end_id` signal — we still
 * de-dup on the canonical key but log the EE-id for QA cross-checks.
 *
 * `donation_id` is NULL on insert and SET by the reconciler when the
 * structured reference matches a `swiss_qr_references` row. ON DELETE
 * SET NULL so a hard-deleted donation (admin-tool path) doesn't leave
 * a dangling FK on the credit-entry row — financial provenance stays.
 */
export const camtCreditEntries = pgTable(
  "camt_credit_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => camtStatements.id, { onDelete: "cascade" }),
    /** ISO 20022 `Ntry.AcctSvcrRef` — entry-level idempotency key. */
    acctSvcrRef: varchar("acct_svcr_ref", { length: 255 }).notNull(),
    /** Optional `EndToEndId` — secondary signal for QA / partial matches. */
    endToEndId: varchar("end_to_end_id", { length: 255 }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    valueDate: date("value_date"),
    bookingDate: date("booking_date"),
    /** Extracted QRR/SCOR if present in `RmtInf.Strd.CdtrRefInf.Ref`. */
    structuredRef: varchar("structured_ref", { length: 40 }),
    debtorName: varchar("debtor_name", { length: 255 }),
    debtorIban: varchar("debtor_iban", { length: 34 }),
    donationId: uuid("donation_id").references(() => donations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("camt_credit_entries_org_idx").on(table.orgId),
    index("camt_credit_entries_statement_idx").on(table.statementId),
    index("camt_credit_entries_donation_idx").on(table.donationId),
    unique("camt_credit_entries_org_statement_acctsvcr_uniq").on(
      table.orgId,
      table.statementId,
      table.acctSvcrRef,
    ),
  ],
);

export type CamtCreditEntry = typeof camtCreditEntries.$inferSelect;
export type NewCamtCreditEntry = typeof camtCreditEntries.$inferInsert;

// ─── camt_unreconciled_entries ──────────────────────────────────────────────

/**
 * Manual-review queue surface. 1:1 with `camt_credit_entries` — the
 * unique on `credit_entry_id` enforces that a single credit produces at
 * most one queue row (resolved or pending or written off).
 *
 * `resolved_by` references `users` ON DELETE SET NULL so a GDPR
 * erasure of an offboarded operator doesn't break the audit trail of
 * "who reconciled this credit" — the row stays, the user pointer
 * goes NULL.
 */
export const camtUnreconciledEntries = pgTable(
  "camt_unreconciled_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    creditEntryId: uuid("credit_entry_id")
      .notNull()
      .references(() => camtCreditEntries.id, { onDelete: "cascade" }),
    reason: camtUnreconciledReasonEnum("reason").notNull(),
    status: camtUnreconciledStatusEnum("status").notNull().default("pending"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("camt_unreconciled_entries_org_idx").on(table.orgId),
    unique("camt_unreconciled_entries_credit_entry_uniq").on(table.creditEntryId),
    index("camt_unreconciled_entries_status_idx").on(table.status),
  ],
);

export type CamtUnreconciledEntry = typeof camtUnreconciledEntries.$inferSelect;
export type NewCamtUnreconciledEntry = typeof camtUnreconciledEntries.$inferInsert;
