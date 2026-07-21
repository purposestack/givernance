/**
 * Query builder for advanced constituent filtering
 * Converts filter DSL to Drizzle ORM queries
 */

import { CUSTOM_FIELD_KEY_PATTERN } from "@givernance/shared/custom-fields";
import { campaignConstituents, constituents, donations } from "@givernance/shared/schema";
import {
  and,
  arrayContains,
  arrayOverlaps,
  between,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTableWithColumns } from "drizzle-orm/pg-core";
import type {
  FieldMetadata,
  FilterCondition,
  FilterOperator,
  FilterQuery,
  PatternType,
} from "./types.js";
import { FIELD_REGISTRY } from "./types.js";

/**
 * Guarded JSONB cast lanes (review MAJOR-3). The documented type-change
 * flow — archive a definition, re-create the same key with a new type —
 * leaves the OLD-typed values in stored blobs (nothing rewrites rows on
 * recreate). An unguarded `::numeric` / `::date` / `::boolean` cast then
 * aborts the WHOLE statement with 22P02 → 500 on the constituent list,
 * filter execute/preview, custom sort, and CSV export. Each cast lane is
 * therefore fenced so a stale, uncastable value evaluates to SQL NULL —
 * "empty never matches" (filters) / "sorts with the empties" (ORDER BY) —
 * instead of erroring. The GIN containment lanes (picklist /
 * multi_picklist / boolean equality) stay untouched: `@>` never casts.
 *
 * Shared by the filter lanes here and the custom ORDER BY lane in
 * `filter.service.ts`. Keys MUST be registry-resolved and
 * `CUSTOM_FIELD_KEY_PATTERN`-checked by the caller before reaching these.
 *
 * `column` is the domain's `custom` JSONB column — defaults to
 * `constituents.custom` so every existing call site is byte-for-byte
 * unchanged; the donations engine passes `donations.custom` (Epic #539
 * donation-domain fast-follow).
 */
export function customNumericExpr(key: string, column: PgColumn = constituents.custom): SQL {
  return sql`CASE WHEN jsonb_typeof(${column} -> ${key}) = 'number' THEN (${column} ->> ${key})::numeric END`;
}

/**
 * Strict `YYYY-MM-DD` shape gate plus `pg_input_is_valid` (PG 16+, and this
 * repo pins PG 17) so a shape-valid but impossible calendar day
 * (`2026-02-30`) is also fenced to NULL instead of raising 22008.
 */
export function customDateExpr(key: string, column: PgColumn = constituents.custom): SQL {
  return sql`CASE WHEN (${column} ->> ${key}) ~ '^\\d{4}-\\d{2}-\\d{2}$' AND pg_input_is_valid(${column} ->> ${key}, 'date') THEN (${column} ->> ${key})::date END`;
}

export function customBooleanExpr(key: string, column: PgColumn = constituents.custom): SQL {
  return sql`CASE WHEN jsonb_typeof(${column} -> ${key}) = 'boolean' THEN (${column} ->> ${key})::boolean END`;
}

export class FilterQueryBuilder {
  private orgId: string;
  private registry: Record<string, FieldMetadata>;
  /** The domain's `custom` JSONB column every custom lane targets. */
  private customColumn: PgColumn;

  /**
   * `registry` is the per-request merged field map (static core registry ∪
   * the org's filterable custom-field definitions) resolved by
   * `getFieldRegistryBundle`. Defaults to the static core registry so
   * callers without custom-field support keep today's behaviour.
   *
   * `customColumn` is the JSONB blob the custom-field lanes compile
   * against. Defaults to `constituents.custom` (identical behaviour for
   * every existing caller); the donations engine passes `donations.custom`
   * so the guarded-cast / containment SQL is reused, not duplicated.
   */
  constructor(
    orgId: string,
    registry: Record<string, FieldMetadata> = FIELD_REGISTRY,
    customColumn: PgColumn = constituents.custom,
  ) {
    this.orgId = orgId;
    this.registry = registry;
    this.customColumn = customColumn;
  }

  /**
   * Build the main WHERE clause from a FilterQuery
   */
  buildWhereClause(query: FilterQuery): SQL | undefined {
    const conditions = this.buildConditions(query.conditions, query.operator);
    const patternConditions = query.patterns
      ? this.buildPatternConditions(query.patterns)
      : undefined;

    if (conditions && patternConditions) {
      return and(conditions, patternConditions);
    }
    return conditions || patternConditions;
  }

  /**
   * Build conditions from an array of filter conditions
   */
  private buildConditions(conditions: FilterCondition[], operator: "AND" | "OR"): SQL | undefined {
    const sqlConditions = conditions
      .map((condition) => this.buildCondition(condition))
      .filter((c): c is SQL => c !== undefined);

    if (sqlConditions.length === 0) return undefined;
    if (sqlConditions.length === 1) return sqlConditions[0];

    return operator === "AND" ? and(...sqlConditions) : or(...sqlConditions);
  }

  /**
   * Build a single condition
   */
  private buildCondition(condition: FilterCondition): SQL | undefined {
    const fieldMeta = this.registry[condition.field];
    if (!fieldMeta) {
      console.warn(`Unknown field: ${condition.field}`);
      return undefined;
    }

    // Handle sub-conditions for complex queries
    if (condition.subConditions) {
      return this.buildWhereClause(condition.subConditions);
    }

    // Third lane beside regular-column and aggregate: custom fields live in
    // the `constituents.custom` JSONB blob and never resolve to a Drizzle
    // column (Epic #539).
    if (fieldMeta.source === "custom") {
      return this.buildCustomFieldCondition(condition.operator, condition.value, fieldMeta);
    }

    // Get the table column reference
    const column = this.getColumnReference(fieldMeta);
    if (!column) return undefined;

    // Build the SQL condition based on operator
    return this.buildOperatorCondition(column, condition.operator, condition.value, fieldMeta);
  }

  /**
   * Get the appropriate column reference for a field.
   *
   * `fieldMeta.column` is the SNAKE_CASE database column name (e.g.
   * `country_code`), but a Drizzle table is keyed by the CAMELCASE JS property
   * name (`countryCode`). Indexing `table[fieldMeta.column]` therefore returned
   * `undefined` for every field whose two names differ (country_code,
   * first_name, last_name, postal_code, created_at) — the condition was then
   * silently dropped and the filter matched everyone. Resolve by the column's
   * real SQL name instead so any field maps correctly.
   */
  private getColumnReference(fieldMeta: FieldMetadata): SQL | undefined {
    const table = this.getTable(fieldMeta.table);
    const columns = getTableColumns(table) as Record<string, { name: string }>;
    const match = Object.values(columns).find((c) => c.name === fieldMeta.column);
    return (match ?? table[fieldMeta.column]) as SQL | undefined;
  }

  /**
   * Get table reference by name
   */
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle requires any here
  private getTable(tableName: string): PgTableWithColumns<any> {
    switch (tableName) {
      case "constituents":
        return constituents;
      case "donations":
        return donations;
      case "campaign_constituents":
        return campaignConstituents;
      default:
        throw new Error(`Unknown table: ${tableName}`);
    }
  }

  /**
   * Translate a legacy SCALAR operator (eq/neq/in) into array semantics when
   * the field migrated from a scalar column to an array one (issue #465 —
   * `constituent.type` → `types text[]`). Persisted segments built before the
   * migration still carry these operators; without translation they error on
   * `text = text[]`. Returns `undefined` when no translation applies so the
   * caller falls through to the normal operator switch.
   */
  private translateScalarOperatorForArray(
    column: SQL,
    operator: FilterOperator,
    value: unknown,
    fieldMeta: FieldMetadata,
  ): SQL | undefined {
    if (fieldMeta.type !== "array") return undefined;
    if (operator === "eq" || operator === "neq") {
      const contains = arrayContains(column, [value]);
      return operator === "eq" ? contains : not(contains);
    }
    // "is any of" on an array column = overlap.
    if (operator === "in" && Array.isArray(value)) return arrayOverlaps(column, value);
    return undefined;
  }

  /**
   * Normalise a DSL value before it hits SQL:
   *  - amount fields declared `valueUnit: "cents"` arrive as a human EUR amount
   *    and must be multiplied by 100 to compare against the `*_cents` column;
   *  - date bounds must include the whole boundary day, else a bare
   *    `YYYY-MM-DD` casts to midnight and silently drops that day's records:
   *    `between` and `lte` extend the UPPER bound to end-of-day, and `gt`
   *    ("after day D") is bumped to end-of-day too. `gte` / `lt` are correct at
   *    midnight and left untouched.
   */
  private normalizeValue(
    fieldMeta: FieldMetadata,
    operator: FilterOperator,
    value: unknown,
  ): unknown {
    let next = value;

    if (fieldMeta.valueUnit === "cents") {
      const toCents = (v: unknown) =>
        v === "" || v === null || v === undefined ? v : Math.round(Number(v) * 100);
      next = Array.isArray(next) ? next.map(toCents) : toCents(next);
    }

    if (fieldMeta.type === "date") {
      if (operator === "between" && Array.isArray(next)) {
        next = [next[0], this.endOfDay(next[1])];
      } else if (operator === "lte" || operator === "gt") {
        next = this.endOfDay(next);
      }
      // Drizzle timestamp columns serialize via value.toISOString(), so a bare
      // date STRING throws on the regular-column path (constituent.createdAt).
      // Coerce to Date; the raw-SQL aggregate date path (last/first gift) binds
      // a Date fine too.
      const toDate = (v: unknown) => (typeof v === "string" && v !== "" ? new Date(v) : v);
      next = Array.isArray(next) ? next.map(toDate) : toDate(next);
    }

    return next;
  }

  /**
   * Custom-date values bind the raw `YYYY-MM-DD` STRING (review m4). The
   * shared `normalizeValue` round-trips through a JS Date, which the pg
   * driver serializes in PROCESS-LOCAL time: west of UTC, the UTC-midnight
   * Date becomes the previous local day and every custom-date eq/bound is
   * off by one. Custom dates compare at `::date` granularity, so the core
   * end-of-day upper-bound convention is a no-op here
   * (`…T23:59:59.999`::date is the same day) — the bare day string is bound
   * untouched; ISO timestamp strings are truncated to their calendar day.
   */
  private normalizeCustomDateValue(value: unknown): unknown {
    const toDay = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : v);
    return Array.isArray(value) ? value.map(toDay) : toDay(value);
  }

  /** Append an end-of-day time to a bare `YYYY-MM-DD` string; pass through the rest. */
  private endOfDay(value: unknown): unknown {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${value}T23:59:59.999`;
    }
    return value;
  }

  /**
   * Build SQL condition based on operator type
   */
  private buildOperatorCondition(
    column: SQL,
    operator: FilterOperator,
    rawValue: unknown,
    fieldMeta: FieldMetadata,
  ): SQL | undefined {
    const value = this.normalizeValue(fieldMeta, operator, rawValue);
    const arrayTranslation = this.translateScalarOperatorForArray(
      column,
      operator,
      value,
      fieldMeta,
    );
    if (arrayTranslation) return arrayTranslation;
    switch (operator) {
      case "eq":
        return eq(column, value);
      case "neq":
        return ne(column, value);
      case "gt":
        return gt(column, value);
      case "gte":
        return gte(column, value);
      case "lt":
        return lt(column, value);
      case "lte":
        return lte(column, value);
      case "between":
        if (Array.isArray(value) && value.length === 2) {
          return between(column, value[0], value[1]);
        }
        return undefined;
      case "in":
        if (Array.isArray(value)) {
          return inArray(column, value);
        }
        return undefined;
      case "contains":
        // Use parameterized query to prevent SQL injection
        return sql`${column} ILIKE ${`%${String(value).replace(/[\\_%]/g, "\\$&")}%`}`;
      case "startsWith":
        // Use parameterized query to prevent SQL injection
        return sql`${column} ILIKE ${`${String(value).replace(/[\\_%]/g, "\\$&")}%`}`;
      case "endsWith":
        // Use parameterized query to prevent SQL injection
        return sql`${column} ILIKE ${`%${String(value).replace(/[\\_%]/g, "\\$&")}`}`;
      case "arrayContains":
        if (fieldMeta.type === "array") {
          return arrayContains(column, Array.isArray(value) ? value : [value]);
        }
        return undefined;
      case "arrayOverlaps":
        if (fieldMeta.type === "array" && Array.isArray(value)) {
          return arrayOverlaps(column, value);
        }
        return undefined;
      case "isNull":
        return isNull(column);
      case "isNotNull":
        return isNotNull(column);
      default:
        console.warn(`Unknown operator: ${operator}`);
        return undefined;
    }
  }

  /**
   * Build a condition against the `constituents.custom` JSONB blob.
   *
   * The JSON key comes from `fieldMeta.jsonKey` (server-resolved from the
   * per-org registry — the DSL only ever carries the dotted `custom.<key>`
   * name) and every value is a bound parameter, so nothing client-supplied
   * is ever interpolated into SQL text. Equality on boolean / picklist /
   * multi_picklist compiles to `@>` containment so the `jsonb_path_ops`
   * GIN index serves it; text / number / currency / date run as cast
   * expressions on `->>` (unindexed by design — acceptable at NPO scale,
   * per-field expression indexes are the documented escape hatch).
   */
  private buildCustomFieldCondition(
    operator: FilterOperator,
    rawValue: unknown,
    fieldMeta: FieldMetadata,
  ): SQL | undefined {
    const key = fieldMeta.jsonKey;
    // Defence-in-depth: the registry only admits regex-clean keys, but this
    // string reaches JSONB path expressions — re-verify before emitting SQL.
    if (!key || !CUSTOM_FIELD_KEY_PATTERN.test(key)) return undefined;

    const custom = this.customColumn;
    // "Has a value" ≡ key present AND not a stored JSON null. The validator
    // never persists nulls, but imported / legacy blobs must still read as
    // empty rather than as a value.
    const present = sql`(jsonb_exists(${custom}, ${key}) AND ${custom} -> ${key} <> 'null'::jsonb)`;
    if (operator === "isNull") return sql`NOT ${present}`;
    if (operator === "isNotNull") return present;

    // Custom dates bypass the shared normalization: comparison happens at
    // `::date` granularity, so the core end-of-day upper-bound convention is
    // a no-op here, and the value MUST stay a string — see
    // normalizeCustomDateValue (review m4).
    if (fieldMeta.customType === "date") {
      return this.buildCustomComparableCondition(
        customDateExpr(key, custom),
        operator,
        this.normalizeCustomDateValue(rawValue),
        (v) => sql`(${v})::date`,
      );
    }

    // Reuses the shared normalization verbatim: currency (valueUnit "cents")
    // gets the EUR → cents ×100.
    const value = this.normalizeValue(fieldMeta, operator, rawValue);

    switch (fieldMeta.customType) {
      case "text":
      case "long_text":
        return this.buildCustomTextCondition(key, operator, value);

      case "number":
      case "currency":
        return this.buildCustomComparableCondition(customNumericExpr(key, custom), operator, value);

      case "boolean": {
        if (typeof value !== "boolean") return undefined;
        if (operator === "eq") return this.customContainment(key, value);
        // For a two-valued type, `neq v` ≡ "present and equals ¬v" — stays on
        // the GIN-served containment path and keeps core-column `neq`
        // semantics (empty values never match).
        if (operator === "neq") return this.customContainment(key, !value);
        return undefined;
      }

      case "picklist":
        return this.buildCustomPicklistCondition(key, operator, value);

      case "multi_picklist":
        return this.buildCustomMultiPicklistCondition(key, operator, value);

      default:
        return undefined;
    }
  }

  private buildCustomPicklistCondition(
    key: string,
    operator: FilterOperator,
    value: unknown,
  ): SQL | undefined {
    if (operator === "eq" && typeof value === "string") {
      return this.customContainment(key, value);
    }
    if (operator === "neq" && typeof value === "string") {
      // `->>` yields SQL NULL for absent keys, so empty values are
      // excluded from neq — same semantics as `ne()` on a core column.
      return sql`${this.customColumn} ->> ${key} <> ${value}`;
    }
    if (operator === "in" && Array.isArray(value)) {
      const clauses = value
        .filter((v): v is string => typeof v === "string")
        .map((v) => this.customContainment(key, v));
      if (clauses.length === 0) return undefined;
      return clauses.length === 1 ? clauses[0] : or(...clauses);
    }
    return undefined;
  }

  private buildCustomMultiPicklistCondition(
    key: string,
    operator: FilterOperator,
    value: unknown,
  ): SQL | undefined {
    const values = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === "string",
    );
    if (values.length === 0) return undefined;
    if (operator === "arrayContains") {
      // JSONB array containment is contains-ALL — one GIN-served probe.
      return this.customContainment(key, values);
    }
    if (operator === "arrayOverlaps") {
      // Contains-ANY = OR of single-element containments, each GIN-served
      // (avoids jsonb_array_elements_text + array binding entirely).
      const clauses = values.map((v) => this.customContainment(key, [v]));
      return clauses.length === 1 ? clauses[0] : or(...clauses);
    }
    return undefined;
  }

  /** `custom @> '{"<key>": <value>}'` — the GIN-served equality probe. */
  private customContainment(key: string, value: unknown): SQL {
    return sql`${this.customColumn} @> ${JSON.stringify({ [key]: value })}::jsonb`;
  }

  private buildCustomTextCondition(
    key: string,
    operator: FilterOperator,
    value: unknown,
  ): SQL | undefined {
    const text = sql`${this.customColumn} ->> ${key}`;
    const escaped = () => String(value).replace(/[\\_%]/g, "\\$&");
    switch (operator) {
      case "eq":
        return sql`${text} = ${String(value)}`;
      case "neq":
        return sql`${text} <> ${String(value)}`;
      case "contains":
        return sql`${text} ILIKE ${`%${escaped()}%`}`;
      case "startsWith":
        return sql`${text} ILIKE ${`${escaped()}%`}`;
      case "endsWith":
        return sql`${text} ILIKE ${`%${escaped()}`}`;
      default:
        return undefined;
    }
  }

  /**
   * Comparison operators over a cast JSONB expression (numeric / date lanes).
   * Absent keys cast to SQL NULL and fail every comparison — the correct
   * "empty never matches" behaviour. `wrap` lets the date lane cast the
   * bound side to `::date`.
   */
  private buildCustomComparableCondition(
    expr: SQL,
    operator: FilterOperator,
    value: unknown,
    wrap: (v: unknown) => SQL = (v) => sql`${v}`,
  ): SQL | undefined {
    switch (operator) {
      case "eq":
        return sql`${expr} = ${wrap(value)}`;
      case "neq":
        return sql`${expr} <> ${wrap(value)}`;
      case "gt":
        return sql`${expr} > ${wrap(value)}`;
      case "gte":
        return sql`${expr} >= ${wrap(value)}`;
      case "lt":
        return sql`${expr} < ${wrap(value)}`;
      case "lte":
        return sql`${expr} <= ${wrap(value)}`;
      case "between":
        if (Array.isArray(value) && value.length === 2) {
          return sql`${expr} BETWEEN ${wrap(value[0])} AND ${wrap(value[1])}`;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * Build conditions for special patterns
   */
  private buildPatternConditions(patterns: PatternType[]): SQL | undefined {
    const conditions = patterns
      .map((pattern) => this.buildPatternCondition(pattern))
      .filter((c): c is SQL => c !== undefined);

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return or(...conditions);
  }

  /**
   * Build condition for a specific pattern
   */
  private buildPatternCondition(pattern: PatternType): SQL | undefined {
    const now = new Date();
    const currentYear = now.getFullYear();

    switch (pattern) {
      case "LYBUNT": {
        // Last Year But Unfortunately Not This
        const lastYearStart = new Date(currentYear - 1, 0, 1);
        const lastYearEnd = new Date(currentYear - 1, 11, 31, 23, 59, 59);
        const thisYearStart = new Date(currentYear, 0, 1);

        return sql`
          EXISTS (
            SELECT 1 FROM ${donations} d1
            WHERE d1.constituent_id = ${constituents.id}
              AND d1.org_id = ${this.orgId}
              AND d1.donated_at >= ${lastYearStart}
              AND d1.donated_at <= ${lastYearEnd}
              AND d1.status = 'cleared'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${donations} d2
            WHERE d2.constituent_id = ${constituents.id}
              AND d2.org_id = ${this.orgId}
              AND d2.donated_at >= ${thisYearStart}
              AND d2.status = 'cleared'
          )
        `;
      }

      case "SYBUNT": {
        // Some Year But Unfortunately Not This
        const thisYearStart = new Date(currentYear, 0, 1);

        return sql`
          EXISTS (
            SELECT 1 FROM ${donations} d1
            WHERE d1.constituent_id = ${constituents.id}
              AND d1.org_id = ${this.orgId}
              AND d1.status = 'cleared'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${donations} d2
            WHERE d2.constituent_id = ${constituents.id}
              AND d2.org_id = ${this.orgId}
              AND d2.donated_at >= ${thisYearStart}
              AND d2.status = 'cleared'
          )
        `;
      }

      case "RECURRING": {
        // Detect regular giving patterns
        // Looking for at least 3 donations in the last 12 months with consistent intervals
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

        return sql`
          EXISTS (
            SELECT 1 FROM (
              SELECT 
                constituent_id,
                COUNT(*) as donation_count,
                EXTRACT(EPOCH FROM (MAX(donated_at) - MIN(donated_at))) / 86400 as days_span,
                COUNT(DISTINCT DATE_TRUNC('month', donated_at)) as unique_months
              FROM ${donations}
              WHERE org_id = ${this.orgId}
                AND status = 'cleared'
                AND donated_at >= ${twelveMonthsAgo}
              GROUP BY constituent_id
              HAVING COUNT(*) >= 3
                AND COUNT(DISTINCT DATE_TRUNC('month', donated_at)) >= 3
            ) recurring
            WHERE recurring.constituent_id = ${constituents.id}
              AND recurring.donation_count >= recurring.unique_months * 0.8
          )
        `;
      }

      case "LAPSED": {
        // No donation in the last 12 months but donated before.
        // (Was 6 months — aligned with the FE preset copy "no gift in 12+ months".)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

        return sql`
          EXISTS (
            SELECT 1 FROM ${donations} d1
            WHERE d1.constituent_id = ${constituents.id}
              AND d1.org_id = ${this.orgId}
              AND d1.status = 'cleared'
              AND d1.donated_at < ${twelveMonthsAgo}
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${donations} d2
            WHERE d2.constituent_id = ${constituents.id}
              AND d2.org_id = ${this.orgId}
              AND d2.status = 'cleared'
              AND d2.donated_at >= ${twelveMonthsAgo}
          )
        `;
      }

      case "MAJOR_DONOR": {
        // Lifetime total donations above 1000 EUR.
        // (Removed the 12-month window — the FE preset and audit both define
        // major donors by lifetime giving, not a rolling 12-month sum.)
        const thresholdCents = 100000; // 1000 EUR

        return sql`
          EXISTS (
            SELECT 1 FROM (
              SELECT
                constituent_id,
                SUM(amount_base_cents) as total_amount
              FROM ${donations}
              WHERE org_id = ${this.orgId}
                AND status = 'cleared'
              GROUP BY constituent_id
              HAVING SUM(amount_base_cents) >= ${thresholdCents}
            ) major_donors
            WHERE major_donors.constituent_id = ${constituents.id}
          )
        `;
      }

      default:
        console.warn(`Unknown pattern: ${pattern}`);
        return undefined;
    }
  }

  /**
   * Apply field-specific filters on aggregated data
   */
  buildAggregateCondition(
    field: string,
    operator: FilterOperator,
    rawValue: unknown,
  ): SQL | undefined {
    const fieldMeta = this.registry[field];
    if (!fieldMeta?.aggregate) return undefined;

    const value = this.normalizeValue(fieldMeta, operator, rawValue);

    // Map field to the aggregated column name. Only fields whose column is
    // actually SELECTed by the runtime `donation_stats` subquery
    // (filter.service.ts) are listed here — averageAmount/campaign_count were
    // removed because their columns are never projected (would 42703 → 500).
    const columnMapping: Record<string, string> = {
      "donations.totalAmount": "total_amount_cents",
      "donations.count": "donation_count",
      "donations.lastDate": "last_donation_date",
      "donations.firstDate": "first_donation_date",
    };

    const columnName = columnMapping[field];
    if (!columnName) return undefined;

    // Build condition using the aggregated column. COUNT/SUM aggregates are
    // COALESCE'd to 0 so a constituent with zero cleared donations (LEFT JOIN →
    // NULL) is treated as count 0 / total 0: `count = 0` and `count < n` then
    // correctly MATCH the never-donated set, while `count >= 1` still excludes
    // it. Date aggregates (MAX/MIN) are left raw — a NULL last/first-gift date
    // must fail every date comparison, which is the desired "never donated"
    // exclusion for those fields.
    const identifier = sql.identifier(columnName);
    const isZeroMeaningful = fieldMeta.aggregate === "count" || fieldMeta.aggregate === "sum";
    const column = isZeroMeaningful ? sql`COALESCE(${identifier}, 0)` : identifier;

    switch (operator) {
      case "eq":
        return sql`${column} = ${value}`;
      case "neq":
        return sql`${column} != ${value}`;
      case "gt":
        return sql`${column} > ${value}`;
      case "gte":
        return sql`${column} >= ${value}`;
      case "lt":
        return sql`${column} < ${value}`;
      case "lte":
        return sql`${column} <= ${value}`;
      case "between":
        if (Array.isArray(value) && value.length === 2) {
          return sql`${column} BETWEEN ${value[0]} AND ${value[1]}`;
        }
        return undefined;
      case "isNull":
        return sql`${column} IS NULL`;
      case "isNotNull":
        return sql`${column} IS NOT NULL`;
      default:
        return undefined;
    }
  }
}
