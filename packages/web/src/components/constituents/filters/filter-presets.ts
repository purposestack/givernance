import type { FilterCategory, FilterField, FilterOperator, FilterPreset } from "./filter-types";

/**
 * Pre-defined filter templates for common NPO segmentation patterns.
 *
 * Every preset is shaped to be accepted by the BE pipeline:
 *   `packages/api/src/modules/constituents/filters/filter.service.ts → validateQuery`
 * The BE accepts only fields declared in `FIELD_REGISTRY` (see
 * `packages/api/src/modules/constituents/filters/types.ts`) and only the
 * five pattern flags (`LYBUNT | SYBUNT | RECURRING | LAPSED | MAJOR_DONOR`).
 *
 * Pattern-only presets emit `conditions: []` + a `patterns` array — the BE
 * pipeline now accepts pattern-only queries (parallel BE change relaxes
 * `validateQuery` to allow empty `conditions` when `patterns` is non-empty).
 * Previously these presets carried a sentinel
 * `constituent.createdAt >= 1970-01-01` condition because the old BE rejected
 * zero-condition queries; that sentinel leaked into the operator-facing
 * "Active filters" chip strip as a useless `createdAt >= 1970` chip, which is
 * the UX bug this change resolves.
 *
 * --- i18n contract (Epic #421 follow-up) ---
 *
 * Every `name`, `description`, `label`, and option `label` in this file is a
 * **next-intl translation key** relative to the `constituents.filters`
 * namespace (NOT the human-readable string). Render sites
 * (`FilterPresets`, `FilterCondition`, `FilterChip`, `campaign-members-card`)
 * resolve these keys with `useTranslations("constituents.filters")(...)`.
 *
 * Stored as keys (not strings) so we never have to thread `t` into this
 * pure-data module and so the FE/BE field-name dotted notation
 * (`donations.lastDate`) maps cleanly to nested JSON keys
 * (`fields.donations.lastDate`).
 *
 * Field/value/operator translation paths (relative to `constituents.filters`):
 *   - operators: `operators.{eq|neq|gt|gte|lt|lte|between|in|contains|startsWith|endsWith|arrayContains|arrayOverlaps|isNull|isNotNull}`
 *   - categories: `categories.{identity|demographics|donation_history}`
 *   - field labels: `fields.<dotted.field.name>`
 *   - select options: `fieldOptions.<dotted.field.name>.<value>`
 *   - presets: `presets.items.<presetIdCamelCase>.{name|description}`
 */

export const filterPresets: FilterPreset[] = [
  {
    id: "lybunt",
    name: "presets.items.lybunt.name",
    description: "presets.items.lybunt.description",
    query: {
      operator: "AND",
      conditions: [],
      patterns: ["LYBUNT"],
    },
  },
  {
    id: "major-donors",
    name: "presets.items.majorDonors.name",
    description: "presets.items.majorDonors.description",
    query: {
      operator: "AND",
      conditions: [],
      patterns: ["MAJOR_DONOR"],
    },
  },
  {
    id: "recurring-monthly",
    name: "presets.items.recurringMonthly.name",
    description: "presets.items.recurringMonthly.description",
    query: {
      operator: "AND",
      conditions: [],
      patterns: ["RECURRING"],
    },
  },
  {
    id: "new-donors",
    name: "presets.items.newDonors.name",
    description: "presets.items.newDonors.description",
    // No BE pattern matches "first gift in window" (NEW_DONOR doesn't exist in
    // PatternType). We use the `donations.firstDate` aggregate field as a proxy.
    // This is now correct: the aggregate-NULL escape hatch was removed from
    // `FilterService.buildCompleteWhereClause`, so a constituent with zero
    // cleared donations has no donation_stats row and fails `first_donation_date
    // >= <90d ago>` instead of leaking through. Only genuine recent first-time
    // donors match.
    query: {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "donations.firstDate",
          operator: "gte",
          value: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
  },
  {
    id: "lapsed-donors",
    name: "presets.items.lapsedDonors.name",
    description: "presets.items.lapsedDonors.description",
    query: {
      operator: "AND",
      conditions: [],
      patterns: ["LAPSED"],
    },
  },
  {
    id: "local-geneva",
    name: "presets.items.localGeneva.name",
    // `address.canton` does not exist (no canton column), so we approximate
    // Geneva with case/accent-insensitive city matches (ILIKE via `contains`)
    // plus the 1200–1299 postal band. `contains` catches "GENÈVE", "geneve",
    // etc. that the old exact `eq` silently dropped. Caveat: the postal "12%"
    // branch also matches German Berlin / French Aveyron codes on multi-country
    // tenants — proper country/canton scoping needs a nested AND group (or a
    // canton column) and is tracked as roadmap in docs/30-advanced-filters.md.
    description: "presets.items.localGeneva.description",
    query: {
      operator: "OR",
      conditions: [
        {
          id: "1",
          field: "address.city",
          operator: "contains",
          value: "genèv",
        },
        {
          id: "2",
          field: "address.city",
          operator: "contains",
          value: "genev",
        },
        {
          id: "3",
          field: "address.postalCode",
          operator: "startsWith",
          value: "12",
        },
      ],
    },
  },
];

/**
 * Available filter fields with their metadata.
 *
 * `label` is an i18n key under `constituents.filters.fields.*`. For dotted
 * field names (e.g. `donations.lastDate`) the i18n JSON nests the path so
 * `t("fields.donations.lastDate")` walks the tree — `next-intl` interprets
 * dots as path separators. Likewise option `label` values are keys under
 * `constituents.filters.fieldOptions.<field>.<value>`.
 *
 * `placeholder` is also an i18n key (single token, no dots) under
 * `constituents.filters.placeholders.*`.
 */
export const filterFields: FilterField[] = [
  // ── Identity & contact ────────────────────────────────────────────────
  {
    name: "constituent.firstName",
    label: "fields.constituent.firstName",
    type: "text",
    category: "identity",
    // first_name is NOT NULL → no presence operators.
    operators: ["eq", "neq", "contains", "startsWith", "endsWith"],
  },
  {
    name: "constituent.lastName",
    label: "fields.constituent.lastName",
    type: "text",
    category: "identity",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith"],
  },
  {
    name: "constituent.email",
    label: "fields.constituent.email",
    type: "text",
    category: "identity",
    // email is nullable → isNull ("has no email") / isNotNull ("has an email")
    // are the data-hygiene / postal-only segments operators actually need.
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  {
    name: "constituent.phone",
    label: "fields.constituent.phone",
    type: "text",
    category: "identity",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  {
    name: "constituent.createdAt",
    label: "fields.constituent.createdAt",
    type: "date",
    category: "identity",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },

  // ── Demographics ──────────────────────────────────────────────────────
  {
    // Multi-valued constituent type (issue #465). `arrayOverlaps` = "is any of"
    // (default), `arrayContains` = "is all of". types is NOT NULL so no
    // presence operators. Option labels mirror the canonical
    // `constituents.types.*` wording.
    name: "constituent.type",
    label: "fields.constituent.type",
    type: "multiselect",
    category: "demographics",
    operators: ["arrayOverlaps", "arrayContains"],
    options: [
      { value: "donor", label: "fieldOptions.constituent.type.donor" },
      { value: "volunteer", label: "fieldOptions.constituent.type.volunteer" },
      { value: "member", label: "fieldOptions.constituent.type.member" },
      { value: "beneficiary", label: "fieldOptions.constituent.type.beneficiary" },
      { value: "partner", label: "fieldOptions.constituent.type.partner" },
    ],
  },
  {
    // tags is a nullable text[] — values are tenant-defined, so options are
    // fetched from the suggestions endpoint at edit-time. isNull ("has no
    // tags") / isNotNull ("has tags") work with no value.
    name: "constituent.tags",
    label: "fields.constituent.tags",
    type: "multiselect",
    category: "demographics",
    operators: ["arrayOverlaps", "arrayContains", "isNull", "isNotNull"],
    asyncSuggestions: true,
    placeholder: "placeholders.selectTags",
  },
  {
    name: "address.city",
    label: "fields.address.city",
    type: "text",
    category: "demographics",
    // No `in` here: city is free text with no picklist, so a multi-city
    // "is any of" needs a searchable multiselect (roadmap, docs/30 §7).
    // `contains` covers substring search in the meantime.
    operators: ["eq", "neq", "contains", "startsWith", "isNull", "isNotNull"],
    placeholder: "placeholders.cityName",
  },
  {
    name: "address.postalCode",
    label: "fields.address.postalCode",
    type: "text",
    category: "demographics",
    // postal_code is a varchar — `between` was removed (lexicographic text
    // ranges are the wrong tool and 400'd BE-side). `startsWith` covers bands.
    operators: ["eq", "neq", "startsWith", "contains", "isNull", "isNotNull"],
    placeholder: "placeholders.postalCode",
  },
  {
    // Field name MUST match the BE FIELD_REGISTRY key `address.countryCode`.
    name: "address.countryCode",
    label: "fields.address.countryCode",
    type: "select",
    category: "demographics",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    options: [
      { value: "CH", label: "fieldOptions.address.countryCode.CH" },
      { value: "FR", label: "fieldOptions.address.countryCode.FR" },
      { value: "DE", label: "fieldOptions.address.countryCode.DE" },
      { value: "IT", label: "fieldOptions.address.countryCode.IT" },
      { value: "AT", label: "fieldOptions.address.countryCode.AT" },
    ],
  },

  // ── Donation history (aggregates over cleared donations) ──────────────
  {
    // Renamed from `donations.lifetime` to match the BE FIELD_REGISTRY key.
    // Amount is entered in EUR; the BE multiplies by 100 (valueUnit: "cents").
    name: "donations.totalAmount",
    label: "fields.donations.totalAmount",
    type: "number",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 100,
    placeholder: "placeholders.amountEur",
  },
  {
    name: "donations.count",
    label: "fields.donations.count",
    type: "number",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 1,
  },
  {
    name: "donations.lastDate",
    label: "fields.donations.lastDate",
    type: "date",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },
  {
    // Field name MUST match the BE `FIELD_REGISTRY` key ("donations.firstDate").
    name: "donations.firstDate",
    label: "fields.donations.firstDate",
    type: "date",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },
];

/**
 * Get the i18n key (under `constituents.filters`) for an operator's display
 * label. Returns a translation key — callers must resolve it via
 * `useTranslations("constituents.filters")(getOperatorLabel(op))`.
 */
export function getOperatorLabel(operator: FilterOperator): string {
  const keys: Record<FilterOperator, string> = {
    eq: "operators.eq",
    neq: "operators.neq",
    gt: "operators.gt",
    gte: "operators.gte",
    lt: "operators.lt",
    lte: "operators.lte",
    between: "operators.between",
    in: "operators.in",
    contains: "operators.contains",
    startsWith: "operators.startsWith",
    endsWith: "operators.endsWith",
    arrayContains: "operators.arrayContains",
    arrayOverlaps: "operators.arrayOverlaps",
    isNull: "operators.isNull",
    isNotNull: "operators.isNotNull",
  };
  return keys[operator] || operator;
}

/**
 * Get the i18n key (under `constituents.filters`) for a category's display
 * label. Returns a translation key — callers must resolve it via
 * `useTranslations("constituents.filters")(getCategoryLabel(cat))`.
 */
export function getCategoryLabel(category: FilterCategory): string {
  // Every category key follows the same `categories.<value>` shape in both
  // domain namespaces (constituents.filters / donations.filters), so this is
  // a pure template — no per-domain map to keep in sync.
  return `categories.${category}`;
}
