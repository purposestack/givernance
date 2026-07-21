/**
 * Business logic for advanced constituent filtering
 */

import { createHash } from "node:crypto";
import { CUSTOM_FIELD_KEY_PATTERN } from "@givernance/shared/custom-fields";
import {
  campaignConstituents,
  campaigns,
  constituents,
  donations,
} from "@givernance/shared/schema";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { withTenantContext } from "../../../lib/db.js";
import type { FieldRegistryBundle } from "./field-registry.js";
import { PatternDetector } from "./pattern-detector.js";
import {
  customBooleanExpr,
  customDateExpr,
  customNumericExpr,
  FilterQueryBuilder,
} from "./query-builder.js";
import type {
  FieldMetadata,
  FilterCondition,
  FilterPreviewRequest,
  FilterPreviewResult,
  FilterQuery,
  FilterRequest,
  FilterResult,
  FilterSuggestionsRequest,
} from "./types.js";
import { FIELD_REGISTRY } from "./types.js";

const NO_ARCHIVED_FIELDS: ReadonlySet<string> = new Set();

/**
 * The `donation_stats` inline aggregate every advanced-filter query LEFT JOINs.
 * `buildAggregateCondition` (query-builder.ts) emits UNQUALIFIED column
 * references (`donation_count`, `total_amount_cents`, `last_donation_date`,
 * `first_donation_date`) that only resolve when a join with EXACTLY this alias
 * and projection is present — so every query that embeds a compiled filter
 * where-clause must join through this helper. Exported for `listConstituents`
 * (GET /v1/constituents?filters=), which composes the DSL with its own
 * `donation_agg` join (disjoint column names, no collision).
 */
export function donationStatsJoin(orgId: string): { source: SQL; on: SQL } {
  return {
    source: sql`(
      SELECT
        constituent_id,
        COUNT(*) as donation_count,
        SUM(amount_base_cents) as total_amount_cents,
        MAX(donated_at) as last_donation_date,
        MIN(donated_at) as first_donation_date
      FROM ${donations}
      WHERE org_id = ${orgId}
        AND status = 'cleared'
      GROUP BY constituent_id
    ) as donation_stats`,
    on: sql`donation_stats.constituent_id = ${constituents.id}`,
  };
}

export class FilterService {
  private orgId: string;
  private registry: Record<string, FieldMetadata>;
  private archivedDslNames: ReadonlySet<string>;
  private queryBuilder: FilterQueryBuilder;
  private patternDetector: PatternDetector;
  private logger?: FastifyBaseLogger;

  /**
   * `registryBundle` is the per-request merged field map + archived
   * custom-field names from `getFieldRegistryBundle(orgId)`. Callers that
   * omit it (legacy paths, tests) get the static core registry — custom
   * fields then validate as unknown, exactly as if the flag were off.
   */
  constructor(orgId: string, logger?: FastifyBaseLogger, registryBundle?: FieldRegistryBundle) {
    this.orgId = orgId;
    this.registry = registryBundle?.registry ?? FIELD_REGISTRY;
    this.archivedDslNames = registryBundle?.archivedDslNames ?? NO_ARCHIVED_FIELDS;
    this.queryBuilder = new FilterQueryBuilder(orgId, this.registry);
    this.patternDetector = new PatternDetector(orgId);
    this.logger = logger;
  }

  /**
   * Execute a filter query and return constituents
   */
  async executeFilter(request: FilterRequest): Promise<FilterResult> {
    const { query, pagination, sort } = request;
    const page = pagination?.page || 1;
    const perPage = pagination?.perPage || 50;
    const offset = (page - 1) * perPage;

    // Build the query
    const whereClause = this.buildCompleteWhereClause(query);
    const orderByClause = this.buildOrderByClause(sort);

    const result = await withTenantContext(this.orgId, async (db) => {
      // Get total count
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(constituents)
        .leftJoin(donationStatsJoin(this.orgId).source, donationStatsJoin(this.orgId).on)
        .where(and(eq(constituents.orgId, this.orgId), isNull(constituents.deletedAt), whereClause))
        .execute();

      const totalCount = Number(countResult[0]?.count || 0);

      // Get paginated results
      const constituentsResult = await db
        .select({
          ...getTableColumns(constituents),
          donationCount: sql<number>`COALESCE(donation_stats.donation_count, 0)`,
          totalAmountCents: sql<number>`COALESCE(donation_stats.total_amount_cents, 0)`,
          lastDonationDate: sql<Date | null>`donation_stats.last_donation_date`,
        })
        .from(constituents)
        .leftJoin(donationStatsJoin(this.orgId).source, donationStatsJoin(this.orgId).on)
        .where(and(eq(constituents.orgId, this.orgId), isNull(constituents.deletedAt), whereClause))
        .orderBy(orderByClause)
        .limit(perPage)
        .offset(offset)
        .execute();

      // Detect patterns for the results if requested
      let patternMap: Map<string, string[]> | undefined;
      if (query.patterns && query.patterns.length > 0) {
        const constituentIds = constituentsResult.map((c) => c.id);
        patternMap = await this.patternDetector.detectAllPatterns(constituentIds);
      }

      // Enrich results with patterns
      const enrichedResults = constituentsResult.map((constituent) => ({
        ...constituent,
        patterns: patternMap?.get(constituent.id) || [],
      }));

      return {
        data: enrichedResults,
        pagination: {
          page,
          perPage,
          total: totalCount,
          totalPages: Math.ceil(totalCount / perPage),
        },
      };
    });

    return result;
  }

  /**
   * Preview filter results (count only)
   */
  async previewFilter(request: FilterPreviewRequest): Promise<FilterPreviewResult> {
    const { query } = request;
    const startTime = Date.now();

    const whereClause = this.buildCompleteWhereClause(query);

    const result = await withTenantContext(this.orgId, async (db) => {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(constituents)
        .leftJoin(donationStatsJoin(this.orgId).source, donationStatsJoin(this.orgId).on)
        .where(and(eq(constituents.orgId, this.orgId), isNull(constituents.deletedAt), whereClause))
        .execute();

      return {
        count: Number(countResult[0]?.count || 0),
        estimatedTime: Date.now() - startTime,
      };
    });

    return result;
  }

  /**
   * Get autocomplete suggestions for a field
   */
  async getFieldSuggestions(request: FilterSuggestionsRequest): Promise<string[]> {
    const { field, search, limit = 10 } = request;

    // Custom TEXT fields suggest from stored values; picklists answer from
    // their `options` client-side (no DB hit), every other custom type has
    // no meaningful suggestion set. Sensitive (Art. 9) fields never
    // suggest: `SELECT DISTINCT` over their stored values would let any
    // authenticated user enumerate the full value set without
    // record-level access (docs/35 §6).
    const customMeta = this.registry[field];
    if (customMeta?.source === "custom") {
      if (customMeta.customType !== "text" || customMeta.sensitive) return [];
      return this.getCustomFieldSuggestions(customMeta, search, limit);
    }

    // Only support certain fields for suggestions
    const supportedFields = [
      "constituent.type",
      "constituent.tags",
      "address.city",
      "address.postalCode",
      "address.countryCode",
    ];

    if (!supportedFields.includes(field)) {
      return [];
    }

    const result = await withTenantContext(this.orgId, async (db) => {
      switch (field) {
        case "constituent.type": {
          // Issue #465 — `type` is now the `types` array. Unnest so a value
          // that only appears as a non-first type still surfaces as a
          // suggestion. `eq(org_id)` keeps the tenant filter explicit even
          // though RLS also scopes it (issue #430).
          const rows = await db.execute(sql`
            SELECT DISTINCT unnest(types) AS value
            FROM ${constituents}
            WHERE org_id = ${this.orgId}
              AND deleted_at IS NULL
              ${search ? sql`AND EXISTS (SELECT 1 FROM unnest(types) AS t WHERE t ILIKE ${`%${search}%`})` : sql``}
            ORDER BY value
            LIMIT ${limit}
          `);
          return (rows as unknown as Array<{ value: string | null }>)
            .map((r) => r.value)
            .filter((v): v is string => v !== null);
        }

        case "constituent.tags": {
          const tagsResult = await db.execute(sql`
            SELECT DISTINCT unnest(tags) as tag
            FROM ${constituents}
            WHERE org_id = ${this.orgId}
              AND deleted_at IS NULL
              ${search ? sql`AND EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE t ILIKE ${`%${search}%`})` : sql``}
            ORDER BY tag
            LIMIT ${limit}
          `);
          return tagsResult.rows.map((row) => row.tag as string);
        }

        case "address.city": {
          const cities = await db
            .selectDistinct({ value: constituents.city })
            .from(constituents)
            .where(
              and(
                eq(constituents.orgId, this.orgId),
                isNull(constituents.deletedAt),
                search ? sql`${constituents.city} ILIKE ${`%${search}%`}` : undefined,
              ),
            )
            .limit(limit)
            .execute();
          return cities.map((c) => c.value).filter((v): v is string => v !== null);
        }

        case "address.postalCode": {
          const codes = await db
            .selectDistinct({ value: constituents.postalCode })
            .from(constituents)
            .where(
              and(
                eq(constituents.orgId, this.orgId),
                isNull(constituents.deletedAt),
                search ? sql`${constituents.postalCode} LIKE ${`${search}%`}` : undefined,
              ),
            )
            .limit(limit)
            .execute();
          return codes.map((c) => c.value).filter((v): v is string => v !== null);
        }

        case "address.countryCode": {
          const countries = await db
            .selectDistinct({ value: constituents.countryCode })
            .from(constituents)
            .where(
              and(
                eq(constituents.orgId, this.orgId),
                isNull(constituents.deletedAt),
                search ? sql`${constituents.countryCode} ILIKE ${`%${search}%`}` : undefined,
              ),
            )
            .limit(limit)
            .execute();
          return countries.map((c) => c.value).filter((v): v is string => v !== null);
        }

        default:
          return [];
      }
    });

    return result;
  }

  /**
   * `SELECT DISTINCT custom->>'<key>'` for one custom text field. The key is
   * registry-resolved and regex-checked, never client input; `eq(org_id)`
   * stays explicit beside RLS (issue #430).
   */
  private async getCustomFieldSuggestions(
    meta: FieldMetadata,
    search: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const key = meta.jsonKey;
    if (!key || meta.sensitive || !CUSTOM_FIELD_KEY_PATTERN.test(key)) return [];

    return withTenantContext(this.orgId, async (db) => {
      const result = await db.execute(sql`
        SELECT DISTINCT ${constituents.custom} ->> ${key} AS value
        FROM ${constituents}
        WHERE org_id = ${this.orgId}
          AND deleted_at IS NULL
          AND jsonb_exists(custom, ${key})
          ${search ? sql`AND ${constituents.custom} ->> ${key} ILIKE ${`%${search}%`}` : sql``}
        ORDER BY value
        LIMIT ${limit}
      `);
      return result.rows
        .map((row) => row.value as string | null)
        .filter((v): v is string => v !== null && v !== "");
    });
  }

  /**
   * Add filtered constituents to a campaign
   */
  async addFilteredToCampaign(
    campaignId: string,
    query: FilterQuery,
  ): Promise<{ added: number; skipped: number }> {
    // First, verify the campaign exists and belongs to this org
    const campaignExists = await withTenantContext(this.orgId, async (db) => {
      const campaign = await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, this.orgId)))
        .execute();
      return campaign.length > 0;
    });

    if (!campaignExists) {
      throw new Error("Campaign not found");
    }

    // Get filtered constituent IDs
    const whereClause = this.buildCompleteWhereClause(query);

    const result = await withTenantContext(this.orgId, async (db) => {
      // Get all matching constituent IDs
      const matchingConstituents = await db
        .select({ id: constituents.id })
        .from(constituents)
        .leftJoin(donationStatsJoin(this.orgId).source, donationStatsJoin(this.orgId).on)
        .where(and(eq(constituents.orgId, this.orgId), isNull(constituents.deletedAt), whereClause))
        .execute();

      const constituentIds = matchingConstituents.map((c) => c.id);

      if (constituentIds.length === 0) {
        return { added: 0, skipped: 0 };
      }

      // Get existing campaign members
      const existingMembers = await db
        .select({ constituentId: campaignConstituents.constituentId })
        .from(campaignConstituents)
        .where(
          and(
            eq(campaignConstituents.campaignId, campaignId),
            inArray(campaignConstituents.constituentId, constituentIds),
          ),
        )
        .execute();

      const existingIds = new Set(existingMembers.map((m) => m.constituentId));
      const newIds = constituentIds.filter((id) => !existingIds.has(id));

      if (newIds.length === 0) {
        return { added: 0, skipped: existingIds.size };
      }

      // Insert new campaign members
      await db
        .insert(campaignConstituents)
        .values(
          newIds.map((constituentId) => ({
            orgId: this.orgId,
            campaignId,
            constituentId,
            addedAt: new Date(),
          })),
        )
        .execute();

      return { added: newIds.length, skipped: existingIds.size };
    });

    return result;
  }

  /**
   * Build the complete WHERE clause including aggregations.
   *
   * Public: `listConstituents` (GET /v1/constituents?filters=) compiles the
   * DSL through this method to AND the result into its own predicate set.
   * Callers MUST validate the query first (`validateQuery`) and MUST join
   * `donationStatsJoin(orgId)` — aggregate conditions reference that alias.
   */
  buildCompleteWhereClause(query: FilterQuery): SQL | undefined {
    // Separate regular conditions from aggregate conditions
    const regularConditions: FilterCondition[] = [];
    const aggregateConditions: FilterCondition[] = [];

    const conditionsArray = Array.isArray(query.conditions) ? query.conditions : [];
    conditionsArray.forEach((condition) => {
      const fieldMeta = this.registry[condition.field];
      if (fieldMeta?.aggregate) {
        aggregateConditions.push(condition);
      } else {
        regularConditions.push(condition);
      }
    });

    // Build regular WHERE clause
    const regularQuery = { ...query, conditions: regularConditions };
    const regularWhere = this.queryBuilder.buildWhereClause(regularQuery);

    // Build aggregate HAVING conditions
    let aggregateWhere: SQL | undefined;
    if (aggregateConditions.length > 0) {
      const aggregateClauses = aggregateConditions
        .map((condition) =>
          this.queryBuilder.buildAggregateCondition(
            condition.field,
            condition.operator,
            condition.value,
          ),
        )
        .filter((c): c is SQL => c !== undefined);

      if (aggregateClauses.length > 0) {
        // Combine with the SAME logical operator as the query. Previously the
        // OR branch emitted only `aggregateClauses[0]`, silently dropping every
        // other aggregate condition.
        aggregateWhere =
          query.operator === "AND" ? and(...aggregateClauses) : or(...aggregateClauses);

        // No `donation_stats.constituent_id IS NULL OR (...)` escape hatch. An
        // aggregate predicate means "the constituent HAS donation stats AND the
        // predicate holds". Constituents with zero cleared donations have no
        // donation_stats row (LEFT JOIN → NULL columns), so `NULL >= 5` is not
        // true and they are correctly excluded instead of leaking into every
        // donation-metric segment.
      }
    }

    // Combine the regular and aggregate halves with the query operator too
    // (was hard-coded to AND, so any OR that spanned the regular/aggregate
    // boundary silently became an intersection).
    if (regularWhere && aggregateWhere) {
      return query.operator === "OR"
        ? or(regularWhere, aggregateWhere)
        : and(regularWhere, aggregateWhere);
    }
    return regularWhere || aggregateWhere;
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderByClause(sort?: { field: string; order: "asc" | "desc" }): SQL {
    if (!sort) {
      return desc(constituents.createdAt);
    }

    const { field, order } = sort;
    const direction = order === "asc" ? asc : desc;

    // Custom fields sort on a validated cast of the JSONB value, NULLS LAST
    // so empty values always trail regardless of direction. Unknown or
    // non-sortable fields keep the existing silent fallback below.
    const customSort = this.buildCustomOrderByClause(field, order);
    if (customSort) return customSort;

    // Map sort fields to actual columns
    switch (field) {
      case "name":
        return direction(sql`${constituents.lastName}, ${constituents.firstName}`);
      case "email":
        return direction(constituents.email);
      case "createdAt":
        return direction(constituents.createdAt);
      case "lastDonation":
        return direction(sql`donation_stats.last_donation_date`);
      case "totalDonations":
        return direction(sql`donation_stats.total_amount_cents`);
      default:
        return desc(constituents.createdAt);
    }
  }

  /**
   * `ORDER BY (custom->>'<key>')::<type> <dir> NULLS LAST` for registry-
   * validated custom fields. The key never comes from the sort input — it is
   * resolved from the merged registry and regex-checked again before use.
   */
  private buildCustomOrderByClause(field: string, order: "asc" | "desc"): SQL | undefined {
    const meta = this.registry[field];
    if (meta?.source !== "custom") return undefined;
    const key = meta.jsonKey;
    if (!key || !CUSTOM_FIELD_KEY_PATTERN.test(key)) return undefined;

    // Cast lanes reuse the guarded expressions (review MAJOR-3): stale
    // old-typed values left behind by an archive-and-recreate type change
    // sort as NULL (with the empties) instead of 22P02-aborting the query.
    let expr: SQL;
    switch (meta.customType) {
      case "number":
      case "currency":
        expr = customNumericExpr(key);
        break;
      case "date":
        expr = customDateExpr(key);
        break;
      case "boolean":
        expr = customBooleanExpr(key);
        break;
      case "text":
      case "long_text":
      case "picklist":
        expr = sql`${constituents.custom} ->> ${key}`;
        break;
      default:
        // multi_picklist has no meaningful scalar order — fall back.
        return undefined;
    }
    return order === "asc" ? sql`${expr} ASC NULLS LAST` : sql`${expr} DESC NULLS LAST`;
  }

  /**
   * Validate a filter query.
   *
   * `archivedFields` names the `custom.<key>` conditions that reference an
   * ARCHIVED definition — routes surface those as the named 400
   * `custom_field_archived` (a persisted segment must fail loudly, never be
   * silently dropped) instead of the generic invalid-query 400.
   */
  validateQuery(query: FilterQuery): {
    valid: boolean;
    errors: string[];
    archivedFields: string[];
  } {
    const errors: string[] = [];

    // Validate query complexity
    const complexityErrors = this.validateQueryComplexity(query);
    errors.push(...complexityErrors);

    // Validate operator
    if (!["AND", "OR"].includes(query.operator)) {
      errors.push("Invalid logical operator. Must be AND or OR");
    }

    // Validate conditions shape
    if (!Array.isArray(query.conditions)) {
      errors.push("conditions must be an array");
    }

    // A query must have at least one condition OR at least one pattern.
    // Pattern-only queries (e.g. the LYBUNT / LAPSED / MAJOR_DONOR presets)
    // are legitimate and must not be forced to add a sentinel condition just
    // to pass validation — the sentinel pollutes the UI "active filters" strip.
    const conditionsArray = Array.isArray(query.conditions) ? query.conditions : [];
    const patternsArray = Array.isArray(query.patterns) ? query.patterns : [];
    if (conditionsArray.length === 0 && patternsArray.length === 0) {
      errors.push("At least one condition or pattern is required");
    }

    // Validate each condition
    conditionsArray.forEach((condition, index) => {
      const conditionErrors = this.validateSingleCondition(condition, index);
      errors.push(...conditionErrors);
    });

    // Validate patterns
    if (query.patterns) {
      const validPatterns = ["LYBUNT", "SYBUNT", "RECURRING", "LAPSED", "MAJOR_DONOR"];
      query.patterns.forEach((pattern) => {
        if (!validPatterns.includes(pattern)) {
          errors.push(`Invalid pattern: ${pattern}`);
        }
      });
    }

    // A key can be archived AND later re-created (the unique index is partial
    // on archived_at IS NULL) — only unresolvable fields count as archived.
    // Walk nested groups too: a persisted segment referencing an archived
    // field inside a subCondition must still produce the NAMED
    // custom_field_archived 400 (never the generic invalid-query problem,
    // and never a silent drop).
    const archivedSet = new Set<string>();
    const collectArchived = (conditions: FilterCondition[]) => {
      for (const condition of conditions) {
        if (!this.registry[condition.field] && this.archivedDslNames.has(condition.field)) {
          archivedSet.add(condition.field);
        }
        if (condition.subConditions) {
          const nested = condition.subConditions.conditions;
          collectArchived(Array.isArray(nested) ? nested : []);
        }
      }
    };
    collectArchived(conditionsArray);
    const archivedFields = [...archivedSet];
    // Nested archived references get no per-condition error above (the
    // per-condition validation only walks the top level) — force invalid
    // so the query can never execute with the reference silently dropped.
    if (archivedFields.length > 0 && errors.length === 0) {
      errors.push(`Archived custom field referenced: ${archivedFields.join(", ")}`);
    }

    return { valid: errors.length === 0, errors, archivedFields };
  }

  /**
   * Check if a value contains suspicious SQL injection patterns
   */
  private isSuspiciousValue(value: string): boolean {
    const suspiciousPatterns = [
      /--/g, // SQL comments
      /\/\*.*\*\//g, // SQL block comments
      /;\s*(?:DROP|DELETE|UPDATE|INSERT|CREATE|ALTER|EXEC|EXECUTE)/gi, // SQL commands
      /UNION\s+(?:ALL\s+)?SELECT/gi, // UNION attacks
      /\bOR\s+1\s*=\s*1/gi, // Classic injection
      /\bAND\s+1\s*=\s*0/gi, // Classic injection
      /[';]\s*(?:DROP|DELETE|UPDATE)/gi, // Command injection
    ];

    return suspiciousPatterns.some((pattern) => pattern.test(value));
  }

  /**
   * Log suspicious activity for security monitoring. The raw value never
   * enters the (long-retention) log line — with custom fields it can be
   * operator-typed sensitive text that merely happens to contain `--`;
   * a hash + length keeps the forensic correlation signal.
   */
  private logSuspiciousActivity(condition: FilterCondition, _index: number): void {
    if (this.logger) {
      const value = String(condition.value);
      this.logger.warn(
        {
          type: "potential_sql_injection",
          orgId: this.orgId,
          field: condition.field,
          operator: condition.operator,
          valueHash: createHash("sha256").update(value).digest("hex").slice(0, 16),
          valueLength: value.length,
          timestamp: new Date().toISOString(),
        },
        "Potential SQL injection attempt detected",
      );
    }
  }

  /**
   * Validate query complexity to prevent overly complex queries
   */
  private validateQueryComplexity(query: FilterQuery): string[] {
    const errors: string[] = [];
    const MAX_CONDITIONS = 10;
    const MAX_NESTING_DEPTH = 3;

    const countConditions = (q: FilterQuery, depth = 0): number => {
      if (depth > MAX_NESTING_DEPTH) {
        errors.push(`Query nesting depth exceeds maximum of ${MAX_NESTING_DEPTH}`);
        return 0;
      }
      const conditions = Array.isArray(q.conditions) ? q.conditions : [];
      let count = conditions.length;
      conditions.forEach((c) => {
        if (c.subConditions) {
          count += countConditions(c.subConditions, depth + 1);
        }
      });
      return count;
    };

    const totalConditions = countConditions(query);
    if (totalConditions > MAX_CONDITIONS) {
      errors.push(
        `Query complexity exceeds maximum of ${MAX_CONDITIONS} conditions (found ${totalConditions})`,
      );
    }

    return errors;
  }

  /**
   * Validate a single filter condition
   */
  private validateSingleCondition(condition: FilterCondition, index: number): string[] {
    const errors: string[] = [];

    // Check field exists
    const fieldMeta = this.registry[condition.field];
    if (!fieldMeta) {
      if (this.archivedDslNames.has(condition.field)) {
        errors.push(`Archived custom field at condition ${index}: ${condition.field}`);
      } else {
        errors.push(`Unknown field at condition ${index}: ${condition.field}`);
      }
      return errors;
    }

    // Validate operator for field
    if (!fieldMeta.operators.includes(condition.operator)) {
      errors.push(
        `Invalid operator '${condition.operator}' for field '${condition.field}' at condition ${index}`,
      );
    }

    // Validate value requirements
    const valueError = this.validateConditionValueRequirements(condition, index);
    if (valueError) {
      errors.push(valueError);
    }

    // Numeric fields must receive finite numbers — otherwise a value like
    // "abc" reaches the SQL layer as NaN and raises a 500 instead of a clean
    // 400. Skip the value-less presence operators.
    const numericError = this.validateNumericValue(condition, fieldMeta, index);
    if (numericError) {
      errors.push(numericError);
    }

    // Check for SQL injection
    if (condition.value && typeof condition.value === "string") {
      if (this.isSuspiciousValue(condition.value)) {
        errors.push(`Suspicious input detected at condition ${index}`);
        this.logSuspiciousActivity(condition, index);
      }
    }

    return errors;
  }

  /**
   * Reject non-numeric input on number fields (scalar or `between` bounds)
   * before it reaches `Number(value) * 100` / SQL and becomes NaN → 500.
   */
  private validateNumericValue(
    condition: FilterCondition,
    fieldMeta: FieldMetadata,
    index: number,
  ): string | null {
    if (fieldMeta.type !== "number") return null;
    if (condition.operator === "isNull" || condition.operator === "isNotNull") return null;

    const isNumericValue = (v: unknown) =>
      v !== "" && v !== null && v !== undefined && !Number.isNaN(Number(v));
    const values = Array.isArray(condition.value) ? condition.value : [condition.value];
    if (!values.every(isNumericValue)) {
      return `Field '${condition.field}' requires a numeric value at condition ${index}`;
    }
    return null;
  }

  /**
   * Validate value requirements for specific operators
   */
  private validateConditionValueRequirements(
    condition: FilterCondition,
    index: number,
  ): string | null {
    const operatorsNeedingValue = [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "between",
      "in",
      "contains",
      "startsWith",
      "endsWith",
      "arrayContains",
      "arrayOverlaps",
    ];

    if (operatorsNeedingValue.includes(condition.operator) && condition.value === undefined) {
      return `Missing value for operator '${condition.operator}' at condition ${index}`;
    }

    // Validate between values
    if (condition.operator === "between") {
      if (!Array.isArray(condition.value) || condition.value.length !== 2) {
        return `'between' operator requires array of 2 values at condition ${index}`;
      }
    }

    // Validate in values
    if (condition.operator === "in" && !Array.isArray(condition.value)) {
      return `'in' operator requires array value at condition ${index}`;
    }

    return null;
  }
}
