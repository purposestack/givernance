// @ts-nocheck
import { bench, describe } from "vitest";
import type { FilterCondition, FilterQuery } from "../filter-types";
import { buildFilterQuery, optimizeFilterQuery, validateFilterQuery } from "../filter-utils";

// Test constituent type matching the mock data structure
interface TestConstituent {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: {
    street: string;
    city: string;
    postalCode: string;
    country: string;
  };
  donations: {
    lastDate: string;
    lastAmount: number;
    totalAmount: number;
    count: number;
    recurring: boolean;
  };
  tags: string[];
  createdAt: string;
}

// Mock data generators
function generateConstituents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `constituent-${i}`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    email: `user${i}@example.com`,
    phone: `+1234567${String(i).padStart(4, "0")}`,
    address: {
      street: `${i} Main St`,
      city: ["Geneva", "Zurich", "Basel", "Bern"][i % 4],
      postalCode: `${1000 + i}`,
      country: ["CH", "FR", "DE", "IT"][i % 4],
    },
    donations: {
      lastDate: new Date(2025 - Math.floor(i / 365), i % 12, (i % 28) + 1).toISOString(),
      lastAmount: (i % 1000) + 50,
      totalAmount: ((i % 1000) + 50) * ((i % 10) + 1),
      count: (i % 10) + 1,
      recurring: i % 3 === 0,
    },
    tags: i % 2 === 0 ? ["newsletter"] : i % 3 === 0 ? ["vip", "newsletter"] : ["volunteer"],
    createdAt: new Date(2020 + Math.floor(i / 365), i % 12, (i % 28) + 1).toISOString(),
  }));
}

// Generate test data sets
const constituents1k = generateConstituents(1000);
const constituents10k = generateConstituents(10000);
const constituents100k = generateConstituents(100000);

// Sample queries of varying complexity
const simpleQuery: FilterQuery = {
  operator: "AND",
  conditions: [{ id: "1", field: "address.city", operator: "eq", value: "Geneva" }],
};

const mediumQuery: FilterQuery = {
  operator: "AND",
  conditions: [
    { id: "1", field: "address.city", operator: "eq", value: "Geneva" },
    { id: "2", field: "donations.lastAmount", operator: "gte", value: 100 },
    { id: "3", field: "donations.recurring", operator: "eq", value: true },
  ],
};

const complexQuery: FilterQuery = {
  operator: "OR",
  conditions: [
    {
      id: "group1",
      operator: "AND",
      conditions: [
        { id: "1", field: "address.country", operator: "eq", value: "CH" },
        { id: "2", field: "donations.totalAmount", operator: "gte", value: 1000 },
        {
          id: "3",
          field: "donations.lastDate",
          operator: "between",
          value: ["2024-01-01", "2024-12-31"],
        },
      ],
    },
    {
      id: "group2",
      operator: "AND",
      conditions: [
        { id: "4", field: "tags", operator: "contains", value: ["vip"] },
        { id: "5", field: "donations.recurring", operator: "eq", value: true },
      ],
    },
  ],
};

// Mock filter execution function
function executeFilter(query: FilterQuery, data: TestConstituent[]) {
  return data.filter((item) => evaluateConditions(query, item));
}

function evaluateConditions(query: FilterQuery | FilterCondition, item: TestConstituent): boolean {
  if ("field" in query) {
    // Single condition
    return evaluateCondition(query as FilterCondition, item);
  }

  // Group of conditions
  const results = query.conditions.map((condition) => evaluateConditions(condition, item));

  return query.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
}

function evaluateCondition(condition: FilterCondition, item: TestConstituent): boolean {
  const value = getFieldValue(condition.field, item);

  switch (condition.operator) {
    case "eq":
      return value === condition.value;
    case "ne":
      return value !== condition.value;
    case "gt":
      return value > condition.value;
    case "gte":
      return value >= condition.value;
    case "lt":
      return value < condition.value;
    case "lte":
      return value <= condition.value;
    case "contains":
      if (Array.isArray(value)) {
        return Array.isArray(condition.value)
          ? (condition.value as string[]).some((v) => value.includes(v))
          : value.includes(condition.value);
      }
      return String(value).includes(String(condition.value));
    case "between":
      return value >= condition.value[0] && value <= condition.value[1];
    case "exists":
      return value !== null && value !== undefined;
    case "notExists":
      return value === null || value === undefined;
    default:
      return false;
  }
}

function getFieldValue(field: string, item: Record<string, unknown>): unknown {
  const parts = field.split(".");
  let value = item;

  for (const part of parts) {
    if (value === null || value === undefined) return null;
    value = value[part];
  }

  return value;
}

describe("Filter Query Performance", () => {
  bench("Simple query - 1k constituents", () => {
    const result = executeFilter(simpleQuery, constituents1k);
    return result.length;
  });

  bench("Simple query - 10k constituents", () => {
    const result = executeFilter(simpleQuery, constituents10k);
    return result.length;
  });

  bench("Simple query - 100k constituents", () => {
    const result = executeFilter(simpleQuery, constituents100k);
    return result.length;
  });

  bench("Medium query - 1k constituents", () => {
    const result = executeFilter(mediumQuery, constituents1k);
    return result.length;
  });

  bench("Medium query - 10k constituents", () => {
    const result = executeFilter(mediumQuery, constituents10k);
    return result.length;
  });

  bench("Medium query - 100k constituents", () => {
    const result = executeFilter(mediumQuery, constituents100k);
    return result.length;
  });

  bench("Complex query - 1k constituents", () => {
    const result = executeFilter(complexQuery, constituents1k);
    return result.length;
  });

  bench("Complex query - 10k constituents", () => {
    const result = executeFilter(complexQuery, constituents10k);
    return result.length;
  });

  bench("Complex query - 100k constituents", () => {
    const result = executeFilter(complexQuery, constituents100k);
    return result.length;
  });
});

describe("Query Building Performance", () => {
  bench("Build simple query", () => {
    return buildFilterQuery([{ field: "email", operator: "contains", value: "@example.com" }]);
  });

  bench("Build medium query", () => {
    return buildFilterQuery([
      { field: "address.city", operator: "eq", value: "Geneva" },
      { field: "donations.lastAmount", operator: "gte", value: 100 },
      { field: "donations.recurring", operator: "eq", value: true },
      { field: "tags", operator: "contains", value: ["newsletter"] },
    ]);
  });

  bench("Build complex nested query", () => {
    return buildFilterQuery([
      { field: "address.country", operator: "eq", value: "CH" },
      { field: "donations.totalAmount", operator: "between", value: [1000, 5000] },
      { field: "donations.lastDate", operator: "gte", value: "2024-01-01" },
      { field: "tags", operator: "contains", value: ["vip", "newsletter"] },
      { field: "email", operator: "exists", value: null },
      { field: "phone", operator: "startsWith", value: "+41" },
    ]);
  });
});

describe("Query Validation Performance", () => {
  bench("Validate simple query", () => {
    return validateFilterQuery(simpleQuery);
  });

  bench("Validate medium query", () => {
    return validateFilterQuery(mediumQuery);
  });

  bench("Validate complex query", () => {
    return validateFilterQuery(complexQuery);
  });

  bench("Validate invalid query", () => {
    const invalidQuery: FilterQuery = {
      operator: "AND",
      conditions: [
        { id: "1", field: "", operator: "eq", value: "" },
        // @ts-expect-error Testing invalid operator
        { id: "2", field: "test", operator: "invalid", value: null },
      ],
    };
    return validateFilterQuery(invalidQuery);
  });
});

describe("Query Optimization Performance", () => {
  const redundantQuery: FilterQuery = {
    operator: "AND",
    conditions: [
      { id: "1", field: "email", operator: "contains", value: "@example.com" },
      { id: "2", field: "email", operator: "contains", value: "@example.com" }, // Duplicate
      { id: "3", field: "address.city", operator: "eq", value: "Geneva" },
      { id: "4", field: "address.city", operator: "eq", value: "Geneva" }, // Duplicate
    ],
  };

  bench("Optimize query with duplicates", () => {
    return optimizeFilterQuery(redundantQuery);
  });

  bench("Optimize already optimal query", () => {
    return optimizeFilterQuery(mediumQuery);
  });

  bench("Optimize deeply nested query", () => {
    const nestedQuery: FilterQuery = {
      operator: "AND",
      conditions: [
        {
          operator: "OR",
          conditions: [
            {
              operator: "AND",
              conditions: [
                { field: "email", operator: "contains", value: "test" },
                { field: "phone", operator: "exists", value: null },
              ],
            },
          ],
        },
      ],
    };
    return optimizeFilterQuery(nestedQuery);
  });
});

describe("Field Access Performance", () => {
  const deeplyNestedItem = {
    profile: {
      contact: {
        primary: {
          email: {
            address: "test@example.com",
            verified: true,
          },
        },
      },
    },
  };

  bench("Access shallow field", () => {
    return getFieldValue("email", { email: "test@example.com" });
  });

  bench("Access nested field", () => {
    return getFieldValue("address.city", {
      address: { city: "Geneva", country: "CH" },
    });
  });

  bench("Access deeply nested field", () => {
    return getFieldValue("profile.contact.primary.email.address", deeplyNestedItem);
  });

  bench("Access missing field", () => {
    return getFieldValue("nonexistent.field.path", {});
  });
});

// Performance regression tests
describe("Performance Regression Guards", () => {
  bench("Should execute 10k simple filters under 50ms", () => {
    const startTime = performance.now();
    executeFilter(simpleQuery, constituents10k);
    const duration = performance.now() - startTime;

    if (duration > 50) {
      throw new Error(`Performance regression: ${duration}ms > 50ms`);
    }
  });

  bench("Should execute 10k complex filters under 200ms", () => {
    const startTime = performance.now();
    executeFilter(complexQuery, constituents10k);
    const duration = performance.now() - startTime;

    if (duration > 200) {
      throw new Error(`Performance regression: ${duration}ms > 200ms`);
    }
  });

  bench("Should build complex queries under 5ms", () => {
    const startTime = performance.now();
    buildFilterQuery(
      Array.from({ length: 20 }, (_, i) => ({
        field: `field${i}`,
        operator: "eq",
        value: `value${i}`,
      })),
    );
    const duration = performance.now() - startTime;

    if (duration > 5) {
      throw new Error(`Performance regression: ${duration}ms > 5ms`);
    }
  });
});
