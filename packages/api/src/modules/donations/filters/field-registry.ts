/**
 * Donation-grain filterable field catalog (donations sibling of the Epic
 * #418 / ADR-033 constituents engine, flag `donations.advanced_filters`).
 *
 * The DSL, operator vocabulary, value normalization (EUR→cents scaling,
 * end-of-day date bounds), validation, and injection heuristics are all
 * REUSED from `../../constituents/filters/` — this module only supplies
 * the donation-domain data (field map) plus the few lanes the generic
 * builder cannot express (EXISTS subqueries + the virtual donor-name
 * expression, see `./query-builder.ts`).
 *
 * Deliberate differences from the constituents engine:
 *   - No aggregate lane and no patterns (LYBUNT & co are constituent-grain
 *     concepts; a donation IS the row grain — every field is row-local or
 *     a per-row EXISTS).
 *   - Custom-field merge covers DONATION-domain definitions ONLY
 *     (`donations.custom`, domain 'donation', Epic #539): the org's
 *     filterable non-archived defs are merged over the static map as
 *     `custom.<key>`, gated on `donations.custom_fields` (the engine
 *     itself sits behind `donations.advanced_filters` at the routes).
 *     Filtering donations by DONOR (constituent-domain) custom fields is
 *     explicitly vetoed (Epic #539 §6) and must not be added here.
 *   - Enum + uuid value-shape validation (see `validateQuery` in
 *     `./filter.service.ts`): `status`/`payment_source`/receipt status are
 *     Postgres enums and `campaign`/`fund` bind uuids — an out-of-set
 *     value would 22P02 → 500 without the pre-flight check.
 *
 * `stripeFeeCents` / `platformFee*` are super-admin-locked projections
 * and must NEVER appear in this registry (tenant-projection lock).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { CUSTOM_FIELD_KEY_PATTERN } from "@givernance/shared/custom-fields";
import { customFieldDefinitions } from "@givernance/shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { withTenantContext } from "../../../lib/db.js";
import { flagService } from "../../../lib/flags/flag-service.js";
import {
  CUSTOM_FIELD_DSL_PREFIX,
  customFieldToMetadata,
} from "../../constituents/filters/field-registry.js";
import type { FieldMetadata } from "../../constituents/filters/types.js";
import { getActiveDefinitions } from "../../customization/lib/value-service.js";

/** Catalog grouping for the donations FilterBuilder. */
export type DonationFieldCategory = "donation" | "payment" | "attribution" | "receipt" | "custom";

/**
 * Lanes the generic column-based builder cannot express:
 *   - `fund` — EXISTS over `donation_allocations` (1:N; a join would
 *     multiply rows).
 *   - `receiptStatus` — EXISTS over `receipts` (1:N, same rationale;
 *     isNull ≡ "no receipt at all" — the unreceipted filter).
 *   - `pledgeInstallment` — EXISTS over `pledge_installments.donation_id`.
 *   - `donorName` — `first_name || ' ' || last_name` over the LEFT-JOINed
 *     constituents row (the join `listDonations` already performs).
 */
export type DonationVirtualLane = "fund" | "receiptStatus" | "pledgeInstallment" | "donorName";

export interface DonationFieldMetadata extends FieldMetadata {
  /** Routes the condition to a hand-built SQL lane instead of a column. */
  virtual?: DonationVirtualLane;
  /** Donations catalog category (distinct union from the constituents one). */
  donationCategory: DonationFieldCategory;
  /**
   * Closed value set for Postgres-enum-backed fields. Validation rejects
   * values outside this set BEFORE they can hit an enum cast (22P02 → 500).
   * Also serialized into the `/filter/fields` catalog as `options` with
   * `optionsKind: "enum"` (the FE localizes these ids; contrast with
   * `"entity"` options whose labels are tenant data rendered literally).
   */
  enumOptions?: readonly string[];
  /**
   * Value-shape gate for uuid-bound fields (campaign / fund ids). Same
   * rationale as `enumOptions`: a non-uuid string would 22P02 on the
   * `::uuid` cast — reject with a clean 400 instead.
   */
  valueFormat?: "uuid";
  /**
   * Marks fields whose catalog `options` are resolved per-org at request
   * time (`campaigns` / `funds` id+name lists) — serialized with
   * `optionsKind: "entity"`.
   */
  dynamicOptions?: "campaigns" | "funds";
}

export const DONATION_STATUS_VALUES = ["pending", "cleared", "refunded", "failed"] as const;
export const DONATION_PAYMENT_SOURCE_VALUES = ["stripe", "camt053", "manual"] as const;
export const RECEIPT_STATUS_VALUES = ["pending", "generated", "failed"] as const;

/**
 * Static donation field registry. DSL names are the only thing the client
 * ever sends — table/column resolution happens server-side against this
 * map (the DSL never carries raw column names).
 */
export const DONATION_FIELD_REGISTRY: Record<string, DonationFieldMetadata> = {
  // ── Donation details ───────────────────────────────────────────────────
  "donation.amount": {
    name: "donation.amount",
    type: "number",
    table: "donations",
    column: "amount_cents",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    // FE sends a human EUR amount; the column is cents (×100 in the shared
    // normalizeValue). NOTE: the transactional-currency column, matching the
    // legacy `amountMin`/`amountMax` params and the list column the operator
    // sees — NOT `amount_base_cents` (cross-currency comparability is a
    // documented non-goal of v1, see docs/30).
    valueUnit: "cents",
    donationCategory: "donation",
  },
  "donation.currency": {
    name: "donation.currency",
    type: "string",
    table: "donations",
    column: "currency",
    // NOT NULL with default — no presence operators.
    operators: ["eq", "neq", "in"],
    donationCategory: "donation",
  },
  "donation.donatedAt": {
    name: "donation.donatedAt",
    type: "date",
    table: "donations",
    column: "donated_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    donationCategory: "donation",
  },
  "donation.createdAt": {
    name: "donation.createdAt",
    type: "date",
    table: "donations",
    column: "created_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    donationCategory: "donation",
  },
  "donation.fiscalYear": {
    name: "donation.fiscalYear",
    type: "number",
    table: "donations",
    column: "fiscal_year",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "isNull", "isNotNull"],
    donationCategory: "donation",
  },

  // ── Payment ────────────────────────────────────────────────────────────
  "donation.status": {
    name: "donation.status",
    type: "string",
    table: "donations",
    column: "status",
    operators: ["eq", "neq", "in"],
    enumOptions: DONATION_STATUS_VALUES,
    donationCategory: "payment",
  },
  "donation.paymentSource": {
    name: "donation.paymentSource",
    type: "string",
    table: "donations",
    column: "payment_source",
    operators: ["eq", "neq", "in"],
    enumOptions: DONATION_PAYMENT_SOURCE_VALUES,
    donationCategory: "payment",
  },
  "donation.paymentMethod": {
    name: "donation.paymentMethod",
    type: "string",
    table: "donations",
    column: "payment_method",
    // Nullable free text — presence operators are meaningful.
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
    donationCategory: "payment",
  },
  "donation.paymentRef": {
    name: "donation.paymentRef",
    type: "string",
    table: "donations",
    column: "payment_ref",
    operators: ["eq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
    donationCategory: "payment",
  },
  "donation.refundedAt": {
    name: "donation.refundedAt",
    type: "date",
    table: "donations",
    column: "refunded_at",
    // isNotNull ≡ "was refunded" (regardless of when).
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
    donationCategory: "payment",
  },

  // ── Attribution ────────────────────────────────────────────────────────
  "donation.campaign": {
    name: "donation.campaign",
    type: "string",
    table: "donations",
    // Filter by CAMPAIGN ID (exact-picker UX; the catalog ships id+name
    // options), not by joined name — isNull tests `campaign_id IS NULL`
    // ("no campaign"), never the joined row.
    column: "campaign_id",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    valueFormat: "uuid",
    dynamicOptions: "campaigns",
    donationCategory: "attribution",
  },
  "donation.fund": {
    name: "donation.fund",
    type: "string",
    table: "donations",
    column: "id", // unused — virtual lane
    // `in` = "allocated to any of"; isNull = "unallocated".
    operators: ["eq", "in", "isNull", "isNotNull"],
    virtual: "fund",
    valueFormat: "uuid",
    dynamicOptions: "funds",
    donationCategory: "attribution",
  },
  "donor.name": {
    name: "donor.name",
    type: "string",
    table: "constituents",
    column: "first_name", // unused — virtual lane over first || ' ' || last
    operators: ["eq", "contains", "startsWith"],
    virtual: "donorName",
    donationCategory: "attribution",
  },
  "donor.email": {
    name: "donor.email",
    type: "string",
    table: "constituents",
    column: "email",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
    donationCategory: "attribution",
  },
  "donation.isPledgeInstallment": {
    name: "donation.isPledgeInstallment",
    type: "boolean",
    table: "donations",
    column: "id", // unused — virtual lane
    operators: ["eq"],
    virtual: "pledgeInstallment",
    donationCategory: "attribution",
  },

  // ── Receipts ───────────────────────────────────────────────────────────
  "donation.receiptStatus": {
    name: "donation.receiptStatus",
    type: "string",
    table: "donations",
    column: "id", // unused — virtual lane
    // eq = "has a receipt with this status"; isNull = "no receipt at all"
    // (the unreceipted filter); isNotNull = "has any receipt".
    operators: ["eq", "isNull", "isNotNull"],
    virtual: "receiptStatus",
    enumOptions: RECEIPT_STATUS_VALUES,
    donationCategory: "receipt",
  },
  "donation.receiptNumber": {
    name: "donation.receiptNumber",
    type: "string",
    table: "donations",
    column: "receipt_number",
    operators: ["eq", "contains", "startsWith", "isNull", "isNotNull"],
    donationCategory: "receipt",
  },
};

export interface DonationFieldRegistryBundle {
  registry: Record<string, DonationFieldMetadata>;
  /**
   * DSL names (`custom.<key>`) of ARCHIVED donation-domain definitions —
   * mirrors the constituents bundle shape so the generic `validateQuery`
   * turns a persisted `?filters=` link that references an archived field
   * into the named `custom_field_archived` 400 (never a silent drop).
   */
  archivedDslNames: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Per-org two-layer registry bundle (Epic #539): static donation map ∪ the
 * org's filterable non-archived DONATION-domain custom-field definitions,
 * each exposed as `custom.<key>`. One Redis GET (60s-cached catalog) plus
 * one indexed SELECT for archived keys on the warm path; both skipped
 * entirely — merged registry ≡ static registry — when the org's
 * `donations.custom_fields` flag is off. DONOR (constituent-domain)
 * definitions are NEVER merged here (Epic #539 §6 veto).
 */
export async function getDonationFieldRegistryBundle(
  orgId: string,
): Promise<DonationFieldRegistryBundle> {
  const customFieldsEnabled = await flagService.isEnabled(
    FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
    { orgId },
  );
  if (!customFieldsEnabled) {
    return { registry: DONATION_FIELD_REGISTRY, archivedDslNames: EMPTY_SET };
  }

  const [defs, archivedDslNames] = await Promise.all([
    getActiveDefinitions(orgId, "donation"),
    getArchivedDonationDslNames(orgId),
  ]);

  const registry: Record<string, DonationFieldMetadata> = { ...DONATION_FIELD_REGISTRY };
  for (const def of defs) {
    // Defence-in-depth: the DB CHECK enforces the key shape, but the key is
    // interpolated into JSONB path expressions — re-verify before it can
    // enter the registry at all. Core DSL names always win a (impossible by
    // RESERVED_KEYS, but belt-and-braces) collision.
    if (!def.filterable || !CUSTOM_FIELD_KEY_PATTERN.test(def.key)) continue;
    const name = `${CUSTOM_FIELD_DSL_PREFIX}${def.key}`;
    if (DONATION_FIELD_REGISTRY[name]) continue;
    registry[name] = {
      // Shared projection (operators, DSL type, jsonKey, label, options in
      // sortOrder order, sensitive bit, cents valueUnit) — identical
      // serialization contract to the constituents catalog.
      ...customFieldToMetadata(def),
      table: "donations",
      donationCategory: "custom",
    };
  }

  return { registry, archivedDslNames };
}

async function getArchivedDonationDslNames(orgId: string): Promise<ReadonlySet<string>> {
  const rows = await withTenantContext(orgId, (tx) =>
    tx
      .select({ key: customFieldDefinitions.key })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.domain, "donation"),
          isNotNull(customFieldDefinitions.archivedAt),
        ),
      ),
  );
  return new Set(rows.map((row) => `${CUSTOM_FIELD_DSL_PREFIX}${row.key}`));
}
