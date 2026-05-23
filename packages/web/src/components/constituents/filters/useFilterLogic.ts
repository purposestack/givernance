import { useCallback, useMemo, useState } from "react";
import type {
  FilterChipData,
  FilterCondition,
  FilterPreset,
  FilterQuery,
  LogicalOperator,
} from "./filter-types";
import { isQueryEmpty, optimizeFilterQuery, validateFilterQuery } from "./filter-utils";

interface UseFilterLogicOptions {
  initialQuery?: FilterQuery;
  maxConditions?: number;
  onQueryChange?: (query: FilterQuery) => void;
}

interface UseFilterLogicReturn {
  query: FilterQuery;
  setQuery: React.Dispatch<React.SetStateAction<FilterQuery>>;
  addCondition: () => void;
  updateCondition: (index: number, condition: FilterCondition) => void;
  removeCondition: (index: number) => void;
  setOperator: (operator: LogicalOperator) => void;
  applyPreset: (preset: FilterPreset) => void;
  clearQuery: () => void;
  validateQuery: () => { valid: boolean; errors: string[] };
  optimizeQuery: () => void;
  activeFilters: FilterChipData[];
  isEmpty: boolean;
  conditionCount: number;
  canAddMore: boolean;
}

/**
 * Custom hook for managing filter query logic
 */
export function useFilterLogic(options: UseFilterLogicOptions = {}): UseFilterLogicReturn {
  const { initialQuery, maxConditions = 20, onQueryChange } = options;

  const [query, setQuery] = useState<FilterQuery>(
    initialQuery || {
      operator: "AND",
      conditions: [],
    },
  );

  // Call onQueryChange when query changes
  React.useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);

  /**
   * Add a new empty condition to the query
   */
  const addCondition = useCallback(() => {
    setQuery((prev) => {
      const conditionCount = countConditionsRecursive(prev.conditions);

      if (conditionCount >= maxConditions) {
        console.warn(`Maximum conditions (${maxConditions}) reached`);
        return prev;
      }

      const newCondition: FilterCondition = {
        id: `condition-${Date.now()}-${Math.random()}`,
        field: "",
        operator: "eq",
        value: "",
      };

      return {
        ...prev,
        conditions: [...prev.conditions, newCondition],
      };
    });
  }, [maxConditions]);

  /**
   * Update a specific condition by index
   */
  const updateCondition = useCallback((index: number, condition: FilterCondition) => {
    setQuery((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => (i === index ? condition : c)),
    }));
  }, []);

  /**
   * Remove a condition by index
   */
  const removeCondition = useCallback((index: number) => {
    setQuery((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }));
  }, []);

  /**
   * Set the logical operator for combining conditions
   */
  const setOperator = useCallback((operator: LogicalOperator) => {
    setQuery((prev) => ({
      ...prev,
      operator,
    }));
  }, []);

  /**
   * Apply a filter preset
   */
  const applyPreset = useCallback((preset: FilterPreset) => {
    setQuery(preset.query);
  }, []);

  /**
   * Clear all conditions
   */
  const clearQuery = useCallback(() => {
    setQuery({
      operator: "AND",
      conditions: [],
    });
  }, []);

  /**
   * Validate the current query
   */
  const validateQuery = useCallback(() => {
    return validateFilterQuery(query);
  }, [query]);

  /**
   * Optimize the query by removing duplicates and simplifying
   */
  const optimizeQuery = useCallback(() => {
    setQuery((prev) => optimizeFilterQuery(prev));
  }, []);

  /**
   * Convert conditions to filter chips for display
   */
  const activeFilters = useMemo<FilterChipData[]>(() => {
    const chips: FilterChipData[] = [];

    const extractChips = (conditions: (FilterCondition | FilterQuery)[]) => {
      conditions.forEach((condition) => {
        if ("field" in condition && condition.field && condition.value !== "") {
          chips.push({
            id: condition.id,
            label: getFieldLabel(condition.field),
            field: condition.field,
            operator: condition.operator,
            value: condition.value,
          });
        } else if ("conditions" in condition) {
          extractChips(condition.conditions);
        }
      });
    };

    extractChips(query.conditions);
    return chips;
  }, [query]);

  const isEmpty = useMemo(() => isQueryEmpty(query), [query]);

  const conditionCount = useMemo(() => countConditionsRecursive(query.conditions), [query]);

  const canAddMore = conditionCount < maxConditions;

  return {
    query,
    setQuery,
    addCondition,
    updateCondition,
    removeCondition,
    setOperator,
    applyPreset,
    clearQuery,
    validateQuery,
    optimizeQuery,
    activeFilters,
    isEmpty,
    conditionCount,
    canAddMore,
  };
}

/**
 * Count conditions recursively (including nested ones)
 */
function countConditionsRecursive(conditions: (FilterCondition | FilterQuery)[]): number {
  let count = 0;

  conditions.forEach((condition) => {
    if ("field" in condition) {
      count++;
    } else if ("conditions" in condition) {
      count += countConditionsRecursive(condition.conditions);
    }
  });

  return count;
}

/**
 * Get human-readable label for a field
 */
function getFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    phone: "Phone",
    "address.street": "Street",
    "address.city": "City",
    "address.postalCode": "Postal code",
    "address.country": "Country",
    "donations.lastDate": "Last donation date",
    "donations.lastAmount": "Last donation amount",
    "donations.totalAmount": "Total donated",
    "donations.count": "Donation count",
    "donations.recurring": "Recurring donor",
    tags: "Tags",
  };

  return labels[field] || field;
}

// Re-export React for the useEffect
import React from "react";
