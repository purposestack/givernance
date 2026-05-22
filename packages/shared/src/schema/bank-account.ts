/**
 * Bank account schema — canonical home for org-scoped operating accounts.
 *
 * A bank account holds the IBAN / QR-IBAN, holder address, and settlement
 * currency for one of an organisation's payment rails. It is used by:
 *
 *   - `Settings → Bank Accounts` (admin CRUD)
 *   - Swiss QR-bill issuance: `swiss_qr_references` and `camt_statements`
 *     carry a `bank_account_id` FK so every issued reference and every
 *     uploaded statement is anchored to a specific account.
 *   - Fund settlement routing: `funds.bank_account_id` ties a fund to a
 *     settlement account, from which the checkout-config derives the
 *     settlement currency.
 *
 * Originally colocated in `swiss-qr-bill.ts` (Epic #318); extracted here
 * because the concept spans the funds module, the campaign editor, and the
 * Settings UI — well beyond the QR-bill rail.
 * See docs/25-swiss-qr-bill.md §2 "Schema file organisation".
 */

import {
  boolean,
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { tenants } from "./index";

// ─── Enums ──────────────────────────────────────────────────────────────────

/** IBAN classification: regular IBAN or QR-IBAN (IID 30000-31999). */
export const BANK_ACCOUNT_IBAN_KIND_VALUES = ["iban", "qr_iban"] as const;
export type BankAccountIbanKind = (typeof BANK_ACCOUNT_IBAN_KIND_VALUES)[number];

export const bankAccountIbanKindEnum = pgEnum("bank_account_iban_kind", [
  ...BANK_ACCOUNT_IBAN_KIND_VALUES,
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
 * Field caps mirror the QR-bill IG v2.4 / v2.5 structured-address (S)
 * string limits exactly so the renderer never has to truncate:
 * holder_name ≤ 70, street ≤ 70, building_number ≤ 16, postal_code ≤ 16,
 * town ≤ 35, country exactly 2. Combined address (K) is not modelled —
 * v2.5 makes S mandatory from 2026-09-30; we ship S-only by construction.
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
    /** Human-readable label for the operator UI (e.g. "PostFinance CHF", "UBS EUR"). */
    label: varchar("label", { length: 255 }).notNull(),
    holderName: varchar("holder_name", { length: 70 }).notNull(),
    /** IG QR-bill S-address `StrtNm` — street name only, no number. ≤ 70 chars. */
    holderStreet: varchar("holder_street", { length: 70 }).notNull(),
    /** IG QR-bill S-address `BldgNb` — building / house number. ≤ 16 chars per the standard. */
    holderBuildingNumber: varchar("holder_building_number", { length: 16 }),
    /** IG QR-bill S-address `PstCd` — postal code. ≤ 16 chars. */
    holderPostalCode: varchar("holder_postal_code", { length: 16 }).notNull(),
    /** IG QR-bill S-address `TwnNm` — town / city. ≤ 35 chars. */
    holderTown: varchar("holder_town", { length: 35 }).notNull(),
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
    bankName: varchar("bank_name", { length: 100 }),
    /**
     * ISO 4217 alpha-3 settlement currency (e.g. "CHF", "EUR", "GBP").
     * Open-ended varchar(3) — no DB enum — so new currencies can be added
     * without a migration. Validated at the API boundary. No default:
     * operators must explicitly choose the settlement currency.
     */
    currency: varchar("currency", { length: 3 }).notNull(),
    /** When false the account is hidden from the campaign editor but retained for audit. */
    isActive: boolean("is_active").notNull().default(true),
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
