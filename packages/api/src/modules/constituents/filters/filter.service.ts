/**
 * Business logic for advanced constituent filtering
 */

import {
  campaignConstituents,
  campaigns,
  constituents,
  donations,
} from "@givernance/shared/schema";
import { and, asc, desc, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { withTenantContext } from "../../../lib/db.js";
import { PatternDetector } from "./pattern-detector.js";
import { FilterQueryBuilder } from "./query-builder.js";
import type {
  FilterCondition,
  FilterPreviewRequest,
  FilterPreviewResult,
  FilterQuery,
  FilterRequest,
  FilterResult,
  FilterSuggestionsRequest,
} from "./types.js";
import { FIELD_REGISTRY } from "./types.js";

export class FilterService {
  private orgId: string;
  private queryBuilder: FilterQueryBuilder;
  private patternDetector: PatternDetector;
  private logger?: FastifyBaseLogger;

  constructor(orgId: string, logger?: FastifyBaseLogger) {
    this.orgId = orgId;
    this.queryBuilder = new FilterQueryBuilder(orgId);
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
        .leftJoin(
          sql`(
            SELECT 
              constituent_id,
              COUNT(*) as donation_count,
              SUM(amount_base_cents) as total_amount_cents,
              MAX(donated_at) as last_donation_date,
              MIN(donated_at) as first_donation_date
            FROM ${donations}
            WHERE org_id = ${this.orgId}
              AND status = 'cleared'
            GROUP BY constituent_id
          ) as donation_stats`,
          sql`donation_stats.constituent_id = ${constituents.id}`,
        )
        .where(and(eq(constituents.orgId, this.orgId), whereClause))
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
        .leftJoin(
          sql`(
            SELECT 
              constituent_id,
              COUNT(*) as donation_count,
              SUM(amount_base_cents) as total_amount_cents,
              MAX(donated_at) as last_donation_date,
              MIN(donated_at) as first_donation_date
            FROM ${donations}
            WHERE org_id = ${this.orgId}
              AND status = 'cleared'
            GROUP BY constituent_id
          ) as donation_stats`,
          sql`donation_stats.constituent_id = ${constituents.id}`,
        )
        .where(and(eq(constituents.orgId, this.orgId), whereClause))
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
        .leftJoin(
          sql`(
            SELECT 
              constituent_id,
              COUNT(*) as donation_count,
              SUM(amount_base_cents) as total_amount_cents,
              MAX(donated_at) as last_donation_date,
              MIN(donated_at) as first_donation_date
            FROM ${donations}
            WHERE org_id = ${this.orgId}
              AND status = 'cleared'
            GROUP BY constituent_id
          ) as donation_stats`,
          sql`donation_stats.constituent_id = ${constituents.id}`,
        )
        .where(and(eq(constituents.orgId, this.orgId), whereClause))
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
        .leftJoin(
          sql`(
            SELECT 
              constituent_id,
              COUNT(*) as donation_count,
              SUM(amount_base_cents) as total_amount_cents,
              MAX(donated_at) as last_donation_date,
              MIN(donated_at) as first_donation_date
            FROM ${donations}
            WHERE org_id = ${this.orgId}
              AND status = 'cleared'
            GROUP BY constituent_id
          ) as donation_stats`,
          sql`donation_stats.constituent_id = ${constituents.id}`,
        )
        .where(and(eq(constituents.orgId, this.orgId), whereClause))
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
   * Build the complete WHERE clause including aggregations
   */
  private buildCompleteWhereClause(query: FilterQuery): SQL | undefined {
    // Separate regular conditions from aggregate conditions
    const regularConditions: FilterCondition[] = [];
    const aggregateConditions: FilterCondition[] = [];

    const conditionsArray = Array.isArray(query.conditions) ? query.conditions : [];
    conditionsArray.forEach((condition) => {
      const fieldMeta = FIELD_REGISTRY[condition.field];
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
        aggregateWhere =
          query.operator === "AND" ? and(...aggregateClauses) : sql`${aggregateClauses[0]}`;

        // Wrap in a subquery condition
        aggregateWhere = sql`(donation_stats.constituent_id IS NULL OR (${aggregateWhere}))`;
      }
    }

    // Combine conditions
    if (regularWhere && aggregateWhere) {
      return and(regularWhere, aggregateWhere);
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
   * Validate a filter query
   */
  validateQuery(query: FilterQuery): { valid: boolean; errors: string[] } {
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

    return { valid: errors.length === 0, errors };
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
   * Log suspicious activity for security monitoring
   */
  private logSuspiciousActivity(condition: FilterCondition, _index: number): void {
    if (this.logger) {
      this.logger.warn(
        {
          type: "potential_sql_injection",
          orgId: this.orgId,
          field: condition.field,
          operator: condition.operator,
          value: condition.value,
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
    const fieldMeta = FIELD_REGISTRY[condition.field];
    if (!fieldMeta) {
      errors.push(`Unknown field at condition ${index}: ${condition.field}`);
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
