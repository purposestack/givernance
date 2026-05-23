/**
 * Query builder for advanced constituent filtering
 * Converts filter DSL to Drizzle ORM queries
 */

import { campaignConstituents, constituents, donations } from "@givernance/shared/schema";
import {
  and,
  arrayContains,
  arrayOverlaps,
  between,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import type {
  FieldMetadata,
  FilterCondition,
  FilterOperator,
  FilterQuery,
  PatternType,
} from "./types.js";
import { FIELD_REGISTRY } from "./types.js";

export class FilterQueryBuilder {
  private orgId: string;

  constructor(orgId: string) {
    this.orgId = orgId;
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
    const fieldMeta = FIELD_REGISTRY[condition.field];
    if (!fieldMeta) {
      console.warn(`Unknown field: ${condition.field}`);
      return undefined;
    }

    // Handle sub-conditions for complex queries
    if (condition.subConditions) {
      return this.buildWhereClause(condition.subConditions);
    }

    // Get the table column reference
    const column = this.getColumnReference(fieldMeta);
    if (!column) return undefined;

    // Build the SQL condition based on operator
    return this.buildOperatorCondition(column, condition.operator, condition.value, fieldMeta);
  }

  /**
   * Get the appropriate column reference for a field
   */
  private getColumnReference(fieldMeta: FieldMetadata): SQL {
    const table = this.getTable(fieldMeta.table);
    return table[fieldMeta.column] as SQL;
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
   * Build SQL condition based on operator type
   */
  private buildOperatorCondition(
    column: SQL,
    operator: FilterOperator,
    value: unknown,
    fieldMeta: FieldMetadata,
  ): SQL | undefined {
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
        return sql`${column} ILIKE ${`%${String(value).replace(/[_%]/g, "\\$&")}%`}`;
      case "startsWith":
        // Use parameterized query to prevent SQL injection
        return sql`${column} ILIKE ${`${String(value).replace(/[_%]/g, "\\$&")}%`}`;
      case "endsWith":
        // Use parameterized query to prevent SQL injection
        return sql`${column} ILIKE ${`%${String(value).replace(/[_%]/g, "\\$&")}`}`;
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
   * Build aggregation subqueries for fields that require them
   */
  buildAggregationJoins(): Record<string, SQL> {
    return {
      donationStats: sql`
        (
          SELECT 
            constituent_id,
            COUNT(*) as donation_count,
            SUM(amount_base_cents) as total_amount_cents,
            AVG(amount_base_cents) as avg_amount_cents,
            MAX(donated_at) as last_donation_date,
            MIN(donated_at) as first_donation_date
          FROM ${donations}
          WHERE org_id = ${this.orgId}
            AND status = 'cleared'
          GROUP BY constituent_id
        )
      `,
      campaignStats: sql`
        (
          SELECT 
            constituent_id,
            COUNT(DISTINCT campaign_id) as campaign_count,
            ARRAY_AGG(DISTINCT campaign_id) as campaign_ids
          FROM ${campaignConstituents} cc
          INNER JOIN campaigns c ON c.id = cc.campaign_id
          WHERE c.org_id = ${this.orgId}
          GROUP BY constituent_id
        )
      `,
    };
  }

  /**
   * Apply field-specific filters on aggregated data
   */
  buildAggregateCondition(
    field: string,
    operator: FilterOperator,
    value: unknown,
  ): SQL | undefined {
    const fieldMeta = FIELD_REGISTRY[field];
    if (!fieldMeta?.aggregate) return undefined;

    // Map field to the aggregated column name
    const columnMapping: Record<string, string> = {
      "donations.totalAmount": "total_amount_cents",
      "donations.count": "donation_count",
      "donations.lastDate": "last_donation_date",
      "donations.firstDate": "first_donation_date",
      "donations.averageAmount": "avg_amount_cents",
      "campaigns.count": "campaign_count",
    };

    const columnName = columnMapping[field];
    if (!columnName) return undefined;

    // Build condition using the aggregated column
    const column = sql.identifier(columnName);

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
