// @ts-nocheck
import { filterFields } from "./filter-presets";
import type { FilterCondition, FilterField, FilterQuery } from "./filter-types";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  conditionId?: string;
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  conditionId?: string;
  field: string;
  message: string;
  code: string;
}

/**
 * Service for validating filter queries with comprehensive checks
 */
export class FilterValidationService {
  private fieldMap: Map<string, FilterField>;

  constructor() {
    // Build field map for quick lookups
    this.fieldMap = new Map(filterFields.map((field) => [field.name, field]));
  }

  /**
   * Validate an entire filter query
   */
  validateQuery(query: FilterQuery): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Validate top-level structure
    if (!query.operator || !["AND", "OR"].includes(query.operator)) {
      errors.push({
        field: "operator",
        message: "Invalid logical operator",
        code: "INVALID_OPERATOR",
      });
    }

    if (!Array.isArray(query.conditions)) {
      errors.push({
        field: "conditions",
        message: "Conditions must be an array",
        code: "INVALID_CONDITIONS",
      });
      return { valid: false, errors, warnings };
    }

    // Validate each condition
    this.validateConditions(query.conditions, errors, warnings);

    // Check for query complexity
    const conditionCount = this.countConditions(query);
    if (conditionCount > 50) {
      warnings.push({
        field: "query",
        message: `Query has ${conditionCount} conditions. Consider simplifying for better performance.`,
        code: "HIGH_COMPLEXITY",
      });
    }

    // Check for redundant conditions
    this.checkRedundantConditions(query, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a single condition
   */
  validateCondition(condition: FilterCondition): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check if field exists
    if (!condition.field) {
      errors.push({
        conditionId: condition.id,
        field: "field",
        message: "Field is required",
        code: "FIELD_REQUIRED",
      });
      return { valid: false, errors, warnings };
    }

    const fieldDef = this.fieldMap.get(condition.field);
    if (!fieldDef) {
      errors.push({
        conditionId: condition.id,
        field: "field",
        message: `Unknown field: ${condition.field}`,
        code: "UNKNOWN_FIELD",
      });
      return { valid: false, errors, warnings };
    }

    // Check if operator is valid for field
    if (!fieldDef.operators.includes(condition.operator)) {
      errors.push({
        conditionId: condition.id,
        field: "operator",
        message: `Operator "${condition.operator}" is not valid for field "${condition.field}"`,
        code: "INVALID_OPERATOR_FOR_FIELD",
      });
    }

    // Validate value based on field type and operator
    this.validateValue(condition, fieldDef, errors, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate conditions recursively
   */
  private validateConditions(
    conditions: import("./filter-types").FilterCondition[] | import("./filter-types").FilterQuery[],
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    conditions.forEach((condition, index) => {
      if ("field" in condition) {
        // Single condition
        const result = this.validateCondition(condition as FilterCondition);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      } else if ("operator" in condition && "conditions" in condition) {
        // Nested query
        if (!["AND", "OR"].includes(condition.operator)) {
          errors.push({
            field: `conditions[${index}].operator`,
            message: "Invalid nested operator",
            code: "INVALID_NESTED_OPERATOR",
          });
        }
        this.validateConditions(condition.conditions, errors, warnings);
      } else {
        errors.push({
          field: `conditions[${index}]`,
          message: "Invalid condition structure",
          code: "INVALID_CONDITION",
        });
      }
    });
  }

  /**
   * Validate value based on field type and operator
   */
  private validateValue(
    condition: FilterCondition,
    fieldDef: FilterField,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    const { operator, value } = condition;

    // No value needed for exists/notExists
    if (operator === "exists" || operator === "notExists") {
      if (value !== null && value !== undefined) {
        warnings.push({
          conditionId: condition.id,
          field: "value",
          message: "Value is ignored for exists/notExists operators",
          code: "VALUE_IGNORED",
        });
      }
      return;
    }

    // Check for empty values
    if (value === "" || value === null || value === undefined) {
      errors.push({
        conditionId: condition.id,
        field: "value",
        message: "Value is required",
        code: "VALUE_REQUIRED",
      });
      return;
    }

    // Validate based on operator
    if (operator === "between") {
      if (!Array.isArray(value) || value.length !== 2) {
        errors.push({
          conditionId: condition.id,
          field: "value",
          message: "Between operator requires array of 2 values",
          code: "INVALID_BETWEEN_VALUE",
        });
        return;
      }

      // Validate each value in range
      const [start, end] = value;
      if (!start || !end) {
        errors.push({
          conditionId: condition.id,
          field: "value",
          message: "Both start and end values are required",
          code: "INCOMPLETE_RANGE",
        });
      }

      // Type-specific range validation
      if (fieldDef.type === "date" && start > end) {
        errors.push({
          conditionId: condition.id,
          field: "value",
          message: "End date must be after start date",
          code: "INVALID_DATE_RANGE",
        });
      } else if (fieldDef.type === "number" && Number(start) > Number(end)) {
        errors.push({
          conditionId: condition.id,
          field: "value",
          message: "End value must be greater than start value",
          code: "INVALID_NUMBER_RANGE",
        });
      }
    }

    // Type-specific validation
    this.validateValueType(condition, fieldDef, errors, warnings);
  }

  /**
   * Validate value matches expected field type
   */

  private validateNumberValue(
    condition: FilterCondition,
    fieldDef: FilterField,
    errors: ValidationError[],
  ): void {
    const { value } = condition;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (Number.isNaN(Number(v))) {
          errors.push({
            conditionId: condition.id,
            field: "value",
            message: `Value[${i}] must be a number`,
            code: "INVALID_NUMBER",
          });
        }
      });
    } else if (Number.isNaN(Number(value))) {
      errors.push({
        conditionId: condition.id,
        field: "value",
        message: "Value must be a number",
        code: "INVALID_NUMBER",
      });
    }

    if (fieldDef.min !== undefined || fieldDef.max !== undefined) {
      const numValue = Array.isArray(value) ? value.map(Number) : [Number(value)];
      numValue.forEach((v) => {
        if (fieldDef.min !== undefined && v < Number(fieldDef.min)) {
          errors.push({
            conditionId: condition.id,
            field: "value",
            message: `Value must be at least ${fieldDef.min}`,
            code: "VALUE_TOO_SMALL",
          });
        }
        if (fieldDef.max !== undefined && v > Number(fieldDef.max)) {
          errors.push({
            conditionId: condition.id,
            field: "value",
            message: `Value must be at most ${fieldDef.max}`,
            code: "VALUE_TOO_LARGE",
          });
        }
      });
    }
  }

  private validateDateValue(condition: FilterCondition, errors: ValidationError[]): void {
    const { value } = condition;
    const validateDate = (dateStr: string) => {
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) {
        errors.push({
          conditionId: condition.id,
          field: "value",
          message: "Invalid date format",
          code: "INVALID_DATE",
        });
      }
    };

    if (Array.isArray(value)) {
      value.forEach(validateDate);
    } else {
      validateDate(value as string);
    }
  }

  private validateBooleanValue(condition: FilterCondition, errors: ValidationError[]): void {
    if (typeof condition.value !== "boolean") {
      errors.push({
        conditionId: condition.id,
        field: "value",
        message: "Value must be true or false",
        code: "INVALID_BOOLEAN",
      });
    }
  }

  private validateValueType(
    condition: FilterCondition,
    fieldDef: FilterField,
    errors: ValidationError[],
    _warnings: ValidationWarning[],
  ): void {
    switch (fieldDef.type) {
      case "number":
        this.validateNumberValue(condition, fieldDef, errors);
        break;
      case "date":
        this.validateDateValue(condition, errors);
        break;
      case "boolean":
        this.validateBooleanValue(condition, errors);
        break;
    }
  }

  private checkRedundantConditions(query: FilterQuery, warnings: ValidationWarning[]): void {
    const conditionMap = new Map<string, FilterCondition[]>();

    const collectConditions = (
      conditions:
        | import("./filter-types").FilterCondition[]
        | import("./filter-types").FilterQuery[],
    ) => {
      conditions.forEach((condition) => {
        if ("field" in condition) {
          const key = `${condition.field}:${condition.operator}`;
          if (!conditionMap.has(key)) {
            conditionMap.set(key, []);
          }
          conditionMap.get(key)?.push(condition);
        } else if ("conditions" in condition) {
          collectConditions(condition.conditions);
        }
      });
    };

    collectConditions(query.conditions);

    // Check for duplicate conditions
    conditionMap.forEach((conditions, key) => {
      if (conditions.length > 1) {
        // Check if values are identical
        const values = conditions.map((c) => JSON.stringify(c.value));
        const uniqueValues = new Set(values);

        if (uniqueValues.size < conditions.length) {
          warnings.push({
            field: "conditions",
            message: `Duplicate conditions found for ${key}`,
            code: "DUPLICATE_CONDITIONS",
          });
        }
      }
    });

    // Check for contradictory conditions
    conditionMap.forEach((_conditions, key) => {
      const [field, _operator] = key.split(":");

      // Check for eq and ne on same field
      const eqKey = `${field}:eq`;
      const neKey = `${field}:ne`;

      if (conditionMap.has(eqKey) && conditionMap.has(neKey) && query.operator === "AND") {
        warnings.push({
          field: "conditions",
          message: `Contradictory conditions: ${field} cannot equal and not equal values simultaneously`,
          code: "CONTRADICTORY_CONDITIONS",
        });
      }
    });
  }
}

// Export singleton instance
export const filterValidationService = new FilterValidationService();
