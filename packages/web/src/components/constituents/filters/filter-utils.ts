// @ts-nocheck
import type { FilterCondition, FilterOperator, FilterQuery } from "./filter-types";

type ConditionType = FilterCondition | FilterQuery;

/**
 * Build a filter query from an array of conditions
 */
export function buildFilterQuery(
  conditions: Partial<FilterCondition>[],
  operator: "AND" | "OR" = "AND",
): FilterQuery {
  return {
    operator,
    conditions: conditions.map((condition, index) => ({
      id: condition.id || `condition-${Date.now()}-${index}`,
      field: condition.field || "",
      operator: condition.operator || "eq",
      value: condition.value ?? "",
    })),
  };
}

const VALID_OPERATORS: FilterOperator[] = [
  "eq",
  "neq" as FilterOperator,
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "between",
  "exists",
  "notExists",
];

/**
 * Validate a single filter condition
 */
function validateSingleCondition(cond: FilterCondition, index: number): string[] {
  const errors: string[] = [];

  if (!cond.field) {
    errors.push(`Condition ${index}: Missing field`);
  }

  if (!VALID_OPERATORS.includes(cond.operator)) {
    errors.push(`Condition ${index}: Invalid operator "${cond.operator}"`);
  }

  // Validate value based on operator
  if (cond.operator === "between") {
    if (!Array.isArray(cond.value) || cond.value.length !== 2) {
      errors.push(`Condition ${index}: Between operator requires array of 2 values`);
    } else if (cond.field.includes("Date") && cond.value[0] > cond.value[1]) {
      errors.push(`Condition ${index}: End date must be after start date`);
    }
  } else if (cond.operator !== "exists" && cond.operator !== "notExists") {
    if (cond.value === "" || cond.value === null || cond.value === undefined) {
      errors.push(`Condition ${index}: Missing value`);
    }
  }

  return errors;
}

/**
 * Validate conditions recursively
 */
function validateConditions(conditions: ConditionType[], errors: string[]): void {
  conditions.forEach((condition, index) => {
    if ("operator" in condition && "conditions" in condition) {
      // Nested query
      const nestedValidation = validateFilterQuery(condition as FilterQuery);
      if (!nestedValidation.valid) {
        errors.push(`Nested condition ${index}: ${nestedValidation.errors.join(", ")}`);
      }
    } else {
      // Single condition
      const conditionErrors = validateSingleCondition(condition as FilterCondition, index);
      errors.push(...conditionErrors);
    }
  });
}

/**
 * Validate a filter query
 */
export function validateFilterQuery(query: FilterQuery): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!query.operator || !["AND", "OR"].includes(query.operator)) {
    errors.push("Invalid logical operator");
  }

  if (!Array.isArray(query.conditions)) {
    errors.push("Conditions must be an array");
    return { valid: false, errors };
  }

  validateConditions(query.conditions, errors);

  return { valid: errors.length === 0, errors };
}

/**
 * Optimize a filter query by removing duplicates and simplifying structure
 */
export function optimizeFilterQuery(query: FilterQuery): FilterQuery {
  const seen = new Set<string>();

  const optimizeConditions = (conditions: ConditionType[]): ConditionType[] => {
    return conditions
      .filter((condition) => {
        if ("field" in condition) {
          // Single condition - check for duplicates
          const key = `${condition.field}:${condition.operator}:${JSON.stringify(condition.value)}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        } else {
          // Nested conditions
          return true;
        }
      })
      .map((condition) => {
        if ("conditions" in condition) {
          // Optimize nested conditions
          const optimized = optimizeConditions(condition.conditions);

          // Flatten single-condition groups
          if (optimized.length === 1 && !("conditions" in optimized[0])) {
            return optimized[0];
          }

          return {
            ...condition,
            conditions: optimized,
          };
        }
        return condition;
      });
  };

  return {
    ...query,
    conditions: optimizeConditions(query.conditions),
  };
}

/**
 * Convert a single condition to SQL
 */
function conditionToSQL(condition: ConditionType): string {
  if ("field" in condition) {
    const field = condition.field;
    const value = condition.value;

    switch (condition.operator) {
      case "eq":
        return `${field} = '${value}'`;
      case "neq" as FilterOperator:
        return `${field} != '${value}'`;
      case "gt":
        return `${field} > ${value}`;
      case "gte":
        return `${field} >= ${value}`;
      case "lt":
        return `${field} < ${value}`;
      case "lte":
        return `${field} <= ${value}`;
      case "contains":
        return `${field} LIKE '%${value}%'`;
      case "notContains":
        return `${field} NOT LIKE '%${value}%'`;
      case "startsWith":
        return `${field} LIKE '${value}%'`;
      case "endsWith":
        return `${field} LIKE '%${value}'`;
      case "between":
        return `${field} BETWEEN '${value[0]}' AND '${value[1]}'`;
      case "exists":
        return `${field} IS NOT NULL`;
      case "notExists":
        return `${field} IS NULL`;
      default:
        return "";
    }
  } else {
    // Nested conditions
    const subConditions = (condition as FilterQuery).conditions
      .map((c) => conditionToSQL(c))
      .filter(Boolean);

    if (subConditions.length === 0) return "";
    if (subConditions.length === 1) return subConditions[0] as string;

    return `(${subConditions.join(` ${condition.operator} `)})`;
  }
}

/**
 * Convert filter query to SQL WHERE clause (for debugging/preview)
 */
export function filterQueryToSQL(query: FilterQuery): string {
  const conditions = query.conditions.map((c) => conditionToSQL(c)).filter(Boolean);

  if (conditions.length === 0) return "1=1"; // Always true
  if (conditions.length === 1) return conditions[0] as string;

  return conditions.join(` ${query.operator} `);
}

/**
 * Extract field from condition
 */
function extractFieldsFromCondition(condition: ConditionType, fields: string[]): void {
  if ("field" in condition) {
    fields.push(condition.field);
  } else if ("conditions" in condition) {
    extractFields(condition.conditions, fields);
  }
}

/**
 * Extract fields recursively
 */
function extractFields(conditions: ConditionType[], fields: string[]): void {
  for (const condition of conditions) {
    extractFieldsFromCondition(condition, fields);
  }
}

/**
 * Extract all field names used in a query
 */
export function getQueryFields(query: FilterQuery): string[] {
  const fields: string[] = [];
  extractFields(query.conditions, fields);
  return [...new Set(fields)]; // Remove duplicates
}

/**
 * Count conditions recursively
 */
function countConditionsRecursive(conditions: ConditionType[], count: { value: number }): void {
  conditions.forEach((condition) => {
    if ("field" in condition) {
      count.value++;
    } else if ("conditions" in condition) {
      countConditionsRecursive(condition.conditions, count);
    }
  });
}

/**
 * Count the total number of conditions in a query
 */
export function countConditions(query: FilterQuery): number {
  const count = { value: 0 };
  countConditionsRecursive(query.conditions, count);
  return count.value;
}

/**
 * Check if a query is empty (no conditions)
 */
export function isQueryEmpty(query: FilterQuery): boolean {
  return countConditions(query) === 0;
}

/**
 * Merge two queries with a specified operator
 */
export function mergeQueries(
  query1: FilterQuery,
  query2: FilterQuery,
  operator: "AND" | "OR" = "AND",
): FilterQuery {
  return {
    operator,
    conditions: [query1, query2],
  };
}
