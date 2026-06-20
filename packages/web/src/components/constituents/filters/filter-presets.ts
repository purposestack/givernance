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
 *   - operators: `operators.{eq|neq|gt|gte|lt|lte|between|in|notIn|contains|notContains|startsWith|endsWith|exists|notExists}`
 *   - categories: `categories.{donation_history|donation_patterns|demographics|engagement|calculated}`
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
    // PatternType). We use the `donations.firstDate` aggregate field as a
    // proxy. Caveat: the BE wraps aggregate predicates in
    // `(donation_stats.constituent_id IS NULL OR (...))`, which lets through
    // constituents with zero donations — so this preset is currently too
    // permissive on tenants where many constituents have never donated.
    // TODO(BE): tighten the aggregate-NULL handling in
    // `FilterService.buildCompleteWhereClause` and/or add a real `NEW_DONOR`
    // pattern to `query-builder.ts` so this preset can become pattern-only.
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
    // `address.canton` does not exist in the BE FIELD_REGISTRY — the
    // constituents table has no canton column (see
    // `packages/shared/src/schema/index.ts`). We approximate Geneva using
    // city names (FR/EN) plus the 1200–1299 postal-code band.
    description: "presets.items.localGeneva.description",
    query: {
      operator: "OR",
      conditions: [
        {
          id: "1",
          field: "address.city",
          operator: "eq",
          value: "Geneva",
        },
        {
          id: "2",
          field: "address.city",
          operator: "eq",
          value: "Genève",
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
  // Donation History
  {
    name: "donations.lastDate",
    label: "fields.donations.lastDate",
    type: "date",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "exists", "notExists"],
  },
  {
    name: "donations.lifetime",
    label: "fields.donations.lifetime",
    type: "number",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 100,
    placeholder: "placeholders.amountEur",
  },
  {
    name: "donations.thisYear",
    label: "fields.donations.thisYear",
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
    name: "donations.avgGift",
    label: "fields.donations.avgGift",
    type: "number",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 10,
    placeholder: "placeholders.amountEur",
  },
  {
    name: "donations.largestGift",
    label: "fields.donations.largestGift",
    type: "number",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 100,
    placeholder: "placeholders.amountEur",
  },
  {
    // Field name MUST match the BE `FIELD_REGISTRY` key in
    // packages/api/src/modules/constituents/filters/types.ts ("donations.firstDate").
    // An earlier mismatch (`firstGiftDate` here vs `firstDate` BE-side) made the
    // `new-donors` preset's chip fall back to its raw field name and trigger
    // `MISSING_MESSAGE: constituents.filters.donations.firstDate` at runtime.
    name: "donations.firstDate",
    label: "fields.donations.firstDate",
    type: "date",
    category: "donation_history",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "exists", "notExists"],
  },

  // Donation Patterns
  {
    name: "donations.recurring",
    label: "fields.donations.recurring",
    type: "boolean",
    category: "donation_patterns",
    operators: ["eq"],
  },
  {
    name: "donations.frequency",
    label: "fields.donations.frequency",
    type: "select",
    category: "donation_patterns",
    operators: ["eq", "neq", "in"],
    options: [
      { value: "monthly", label: "fieldOptions.donations.frequency.monthly" },
      { value: "quarterly", label: "fieldOptions.donations.frequency.quarterly" },
      { value: "annual", label: "fieldOptions.donations.frequency.annual" },
      { value: "irregular", label: "fieldOptions.donations.frequency.irregular" },
    ],
  },

  // Demographics
  {
    name: "address.city",
    label: "fields.address.city",
    type: "text",
    category: "demographics",
    operators: ["eq", "neq", "contains", "startsWith", "in"],
    placeholder: "placeholders.cityName",
  },
  {
    name: "address.canton",
    label: "fields.address.canton",
    type: "select",
    category: "demographics",
    operators: ["eq", "neq", "in"],
    // Cantons are proper nouns — their German/French/Italian/Romansh names are
    // already culturally bound to their canton abbreviations. We keep them
    // untranslated (rendered verbatim) rather than fork per-locale spellings
    // that would diverge from official cantonal naming.
    options: [
      { value: "AG", label: "fieldOptions.address.canton.AG" },
      { value: "AI", label: "fieldOptions.address.canton.AI" },
      { value: "AR", label: "fieldOptions.address.canton.AR" },
      { value: "BE", label: "fieldOptions.address.canton.BE" },
      { value: "BL", label: "fieldOptions.address.canton.BL" },
      { value: "BS", label: "fieldOptions.address.canton.BS" },
      { value: "FR", label: "fieldOptions.address.canton.FR" },
      { value: "GE", label: "fieldOptions.address.canton.GE" },
      { value: "GL", label: "fieldOptions.address.canton.GL" },
      { value: "GR", label: "fieldOptions.address.canton.GR" },
      { value: "JU", label: "fieldOptions.address.canton.JU" },
      { value: "LU", label: "fieldOptions.address.canton.LU" },
      { value: "NE", label: "fieldOptions.address.canton.NE" },
      { value: "NW", label: "fieldOptions.address.canton.NW" },
      { value: "OW", label: "fieldOptions.address.canton.OW" },
      { value: "SG", label: "fieldOptions.address.canton.SG" },
      { value: "SH", label: "fieldOptions.address.canton.SH" },
      { value: "SO", label: "fieldOptions.address.canton.SO" },
      { value: "SZ", label: "fieldOptions.address.canton.SZ" },
      { value: "TG", label: "fieldOptions.address.canton.TG" },
      { value: "TI", label: "fieldOptions.address.canton.TI" },
      { value: "UR", label: "fieldOptions.address.canton.UR" },
      { value: "VD", label: "fieldOptions.address.canton.VD" },
      { value: "VS", label: "fieldOptions.address.canton.VS" },
      { value: "ZG", label: "fieldOptions.address.canton.ZG" },
      { value: "ZH", label: "fieldOptions.address.canton.ZH" },
    ],
  },
  {
    name: "address.postalCode",
    label: "fields.address.postalCode",
    type: "text",
    category: "demographics",
    operators: ["eq", "neq", "startsWith", "between"],
    placeholder: "placeholders.postalCode",
  },
  {
    name: "address.country",
    label: "fields.address.country",
    type: "select",
    category: "demographics",
    operators: ["eq", "neq", "in"],
    options: [
      { value: "CH", label: "fieldOptions.address.country.CH" },
      { value: "FR", label: "fieldOptions.address.country.FR" },
      { value: "DE", label: "fieldOptions.address.country.DE" },
      { value: "IT", label: "fieldOptions.address.country.IT" },
      { value: "AT", label: "fieldOptions.address.country.AT" },
    ],
  },
  {
    name: "language",
    label: "fields.language",
    type: "select",
    category: "demographics",
    operators: ["eq", "neq", "in"],
    options: [
      { value: "fr", label: "fieldOptions.language.fr" },
      { value: "de", label: "fieldOptions.language.de" },
      { value: "it", label: "fieldOptions.language.it" },
      { value: "en", label: "fieldOptions.language.en" },
    ],
  },
  {
    // Field name MUST match the BE FIELD_REGISTRY in
    // packages/api/src/modules/constituents/filters/types.ts. Issue #465
    // migrated this from a scalar column to a `text[]` (`types`), so the BE
    // now accepts the array operators `arrayOverlaps` (any-of) / `arrayContains`
    // (all-of) alongside the legacy scalar operators (`eq`/`neq`/`in`, which
    // the BE query-builder translates to array semantics for back-compat).
    // We default to `arrayOverlaps` so the common "any of these types" segment
    // works out of the box, and the FE renders every multi-value operator as a
    // real multi-select (Popover + Checkboxes) so the operator picks one-or-many
    // from the canonical 5 types.
    //
    // This field stays array-typed REGARDLESS of the `constituents.multi_type`
    // flag (issue #465 review). It is NOT gated to single-select when the flag
    // is off, on purpose: (a) the `types` column is always `text[]` — migration
    // 0083 is flag-independent — so array operators are always valid; (b)
    // filtering BY several type values is orthogonal to whether a constituent
    // can HOLD several types (the flag governs assignment, not segmentation);
    // and (c) a hard single-select gate would invalidate persisted segments that
    // were saved with `arrayOverlaps`/`arrayContains` while the flag was on,
    // making them un-editable once it flips off — the opposite of the
    // segment-survival guarantee. The constituent FORM remains single-value when
    // the flag is off (that surface IS gated); only the filter is always rich.
    //
    // Option labels live under `fieldOptions.constituent.type.*`; the JSON
    // values mirror the canonical `constituents.types.*` strings so the FR/EN
    // wording stays in lockstep across the two surfaces (filter dropdown +
    // constituent list table). Reusing the same translator namespace here
    // would require threading a second `useTranslations()` into
    // FilterCondition for one field — not worth the rendering complexity.
    name: "constituent.type",
    label: "fields.constituent.type",
    type: "multiselect",
    category: "demographics",
    operators: ["arrayOverlaps", "arrayContains", "eq", "neq", "in"],
    options: [
      { value: "donor", label: "fieldOptions.constituent.type.donor" },
      { value: "volunteer", label: "fieldOptions.constituent.type.volunteer" },
      { value: "member", label: "fieldOptions.constituent.type.member" },
      { value: "beneficiary", label: "fieldOptions.constituent.type.beneficiary" },
      { value: "partner", label: "fieldOptions.constituent.type.partner" },
    ],
  },
  {
    name: "tags",
    label: "fields.tags",
    type: "multiselect",
    category: "demographics",
    operators: ["contains", "notContains"],
    placeholder: "placeholders.selectTags",
  },

  // Engagement
  {
    name: "email.status",
    label: "fields.email.status",
    type: "select",
    category: "engagement",
    operators: ["eq", "neq"],
    options: [
      { value: "valid", label: "fieldOptions.email.status.valid" },
      { value: "bounced", label: "fieldOptions.email.status.bounced" },
      { value: "unsubscribed", label: "fieldOptions.email.status.unsubscribed" },
      { value: "unknown", label: "fieldOptions.email.status.unknown" },
    ],
  },
  {
    name: "communication.preferences",
    label: "fields.communication.preferences",
    type: "multiselect",
    category: "engagement",
    operators: ["contains", "notContains"],
    options: [
      { value: "email", label: "fieldOptions.communication.preferences.email" },
      { value: "postal", label: "fieldOptions.communication.preferences.postal" },
      { value: "sms", label: "fieldOptions.communication.preferences.sms" },
      { value: "phone", label: "fieldOptions.communication.preferences.phone" },
    ],
  },
  {
    name: "engagement.lastContact",
    label: "fields.engagement.lastContact",
    type: "date",
    category: "engagement",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },

  // Calculated Metrics
  {
    name: "metrics.lifetimeValue",
    label: "fields.metrics.lifetimeValue",
    type: "number",
    category: "calculated",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 100,
    placeholder: "placeholders.amountEur",
  },
  {
    name: "metrics.givingFrequency",
    label: "fields.metrics.givingFrequency",
    type: "number",
    category: "calculated",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 0.5,
  },
  {
    name: "metrics.recencyScore",
    label: "fields.metrics.recencyScore",
    type: "number",
    category: "calculated",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    min: 0,
    step: 1,
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
    notIn: "operators.notIn",
    contains: "operators.contains",
    notContains: "operators.notContains",
    startsWith: "operators.startsWith",
    endsWith: "operators.endsWith",
    exists: "operators.exists",
    notExists: "operators.notExists",
    arrayContains: "operators.arrayContains",
    arrayOverlaps: "operators.arrayOverlaps",
  };
  return keys[operator] || operator;
}

/**
 * Get the i18n key (under `constituents.filters`) for a category's display
 * label. Returns a translation key — callers must resolve it via
 * `useTranslations("constituents.filters")(getCategoryLabel(cat))`.
 */
export function getCategoryLabel(category: FilterCategory): string {
  const keys: Record<FilterCategory, string> = {
    donation_history: "categories.donation_history",
    donation_patterns: "categories.donation_patterns",
    demographics: "categories.demographics",
    engagement: "categories.engagement",
    calculated: "categories.calculated",
  };
  return keys[category] || category;
}
