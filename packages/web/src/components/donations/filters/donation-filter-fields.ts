import type { FilterField } from "@/components/constituents/filters/filter-types";

/**
 * Static donation filter catalog (flag `donations.advanced_filters`) —
 * the donations sibling of `constituents/filters/filter-presets.ts`'s
 * `filterFields`.
 *
 * Source of truth for CORE donation fields: names, operators, input types
 * and i18n label keys are kept in exact lockstep with the BE
 * `DONATION_FIELD_REGISTRY`
 * (`packages/api/src/modules/donations/filters/field-registry.ts`) — any
 * operator offered here that the BE doesn't list would 400 on apply.
 *
 * --- i18n contract ---
 * Every `label` / option `label` / `placeholder` below is a next-intl key
 * RELATIVE to the `donations.filters` namespace (the BE catalog serializes
 * labels in the same relative `fields.<dotted-name>` form):
 *   - field labels: `fields.<dotted.field.name>`
 *   - closed-enum option labels: `options.<dotted.field.name>.<optionId>`
 *   - categories: `categories.{donation|payment|attribution|receipt}`
 *   - operators: `operators.*` (same vocabulary as constituents)
 *
 * ENTITY options (per-org campaign / fund pickers) are NOT listed here —
 * they're tenant data resolved at request time from
 * `GET /v1/donations/filter/fields` (`optionsKind: "entity"`) and merged in
 * by `mergeDonationFilterCatalog`, rendered literally (never through `t()`,
 * hence `optionLabelKind: "literal"` on those two fields).
 *
 * Deliberate FE-side narrowing vs the BE registry:
 *   - `donation.fiscalYear` drops the BE's `in` operator — with no option
 *     list an `in` multiselect has nothing to offer and would emit a scalar
 *     the BE rejects; the comparison operators cover every real use.
 *
 * Donor CUSTOM fields are explicitly vetoed for this catalog (Epic #539 §6).
 * Donation-OWN custom fields are NOT listed here either — they're per-org
 * tenant data (`category: "custom"`, flag `donations.custom_fields`) merged
 * in from the fetched catalog by `mergeDonationFilterCatalog`, with literal
 * labels (`categories.custom` is the one i18n key they use).
 */
export const donationFilterFields: FilterField[] = [
  // ── Donation details ───────────────────────────────────────────────────
  {
    // Amount is entered in EUR; the BE multiplies by 100 (valueUnit "cents",
    // same convention as `donations.totalAmount` on constituents).
    name: "donation.amount",
    label: "fields.donation.amount",
    type: "number",
    category: "donation",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 1,
    placeholder: "placeholders.amountEur",
  },
  {
    // Values are tenant data (whatever currencies the org actually received)
    // → fetched from the suggestions endpoint at edit-time for `in`.
    name: "donation.currency",
    label: "fields.donation.currency",
    type: "text",
    category: "donation",
    operators: ["eq", "neq", "in"],
    asyncSuggestions: true,
    placeholder: "placeholders.currency",
  },
  {
    name: "donation.donatedAt",
    label: "fields.donation.donatedAt",
    type: "date",
    category: "donation",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },
  {
    name: "donation.createdAt",
    label: "fields.donation.createdAt",
    type: "date",
    category: "donation",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },
  {
    name: "donation.fiscalYear",
    label: "fields.donation.fiscalYear",
    type: "number",
    category: "donation",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
    min: 1900,
    step: 1,
    placeholder: "placeholders.fiscalYear",
  },

  // ── Payment ────────────────────────────────────────────────────────────
  {
    name: "donation.status",
    label: "fields.donation.status",
    type: "select",
    category: "payment",
    operators: ["eq", "neq", "in"],
    options: [
      { value: "pending", label: "options.donation.status.pending" },
      { value: "cleared", label: "options.donation.status.cleared" },
      { value: "refunded", label: "options.donation.status.refunded" },
      { value: "failed", label: "options.donation.status.failed" },
    ],
  },
  {
    name: "donation.paymentSource",
    label: "fields.donation.paymentSource",
    type: "select",
    category: "payment",
    operators: ["eq", "neq", "in"],
    options: [
      { value: "stripe", label: "options.donation.paymentSource.stripe" },
      { value: "camt053", label: "options.donation.paymentSource.camt053" },
      { value: "manual", label: "options.donation.paymentSource.manual" },
    ],
  },
  {
    // Free-text tenant data ("TWINT", "cash", …) → async suggestions.
    name: "donation.paymentMethod",
    label: "fields.donation.paymentMethod",
    type: "text",
    category: "payment",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
    asyncSuggestions: true,
  },
  {
    name: "donation.paymentRef",
    label: "fields.donation.paymentRef",
    type: "text",
    category: "payment",
    operators: ["eq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  {
    // isNotNull ≡ "was refunded" (regardless of when).
    name: "donation.refundedAt",
    label: "fields.donation.refundedAt",
    type: "date",
    category: "payment",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
  },

  // ── Attribution ────────────────────────────────────────────────────────
  {
    // Options (per-org campaign id → name) are merged in from the fetched
    // catalog; isNull ≡ "no campaign".
    name: "donation.campaign",
    label: "fields.donation.campaign",
    type: "select",
    category: "attribution",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    options: [],
    optionLabelKind: "literal",
  },
  {
    // `in` ≡ "allocated to any of"; isNull ≡ "unallocated".
    name: "donation.fund",
    label: "fields.donation.fund",
    type: "select",
    category: "attribution",
    operators: ["eq", "in", "isNull", "isNotNull"],
    options: [],
    optionLabelKind: "literal",
  },
  {
    // Virtual `first_name || ' ' || last_name` lane BE-side; eq is
    // case-insensitive exact.
    name: "donor.name",
    label: "fields.donor.name",
    type: "text",
    category: "attribution",
    operators: ["eq", "contains", "startsWith"],
  },
  {
    name: "donor.email",
    label: "fields.donor.email",
    type: "text",
    category: "attribution",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  {
    name: "donation.isPledgeInstallment",
    label: "fields.donation.isPledgeInstallment",
    type: "boolean",
    category: "attribution",
    operators: ["eq"],
  },

  // ── Receipts ───────────────────────────────────────────────────────────
  {
    // eq ≡ "has a receipt with this status"; isNull ≡ UNRECEIPTED (no
    // receipt at all); isNotNull ≡ "has any receipt".
    name: "donation.receiptStatus",
    label: "fields.donation.receiptStatus",
    type: "select",
    category: "receipt",
    operators: ["eq", "isNull", "isNotNull"],
    options: [
      { value: "pending", label: "options.donation.receiptStatus.pending" },
      { value: "generated", label: "options.donation.receiptStatus.generated" },
      { value: "failed", label: "options.donation.receiptStatus.failed" },
    ],
  },
  {
    name: "donation.receiptNumber",
    label: "fields.donation.receiptNumber",
    type: "text",
    category: "receipt",
    operators: ["eq", "contains", "startsWith", "isNull", "isNotNull"],
  },
];
