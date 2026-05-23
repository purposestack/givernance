// @ts-nocheck
import type {
  FilterChipData,
  FilterCondition,
  FilterField,
  FilterPreset,
  FilterQuery,
} from "../filter-types";

/**
 * Mock constituent data for testing
 */
export const mockConstituents = [
  {
    id: "1",
    firstName: "John",
    lastName: "Doe",
    email: "john.doe@example.com",
    phone: "+41791234567",
    address: {
      street: "123 Main St",
      city: "Geneva",
      postalCode: "1200",
      country: "CH",
    },
    donations: {
      lastDate: "2025-04-15",
      lastAmount: 250,
      totalAmount: 2500,
      count: 10,
      recurring: true,
    },
    tags: ["vip", "newsletter"],
    createdAt: "2023-01-01T00:00:00Z",
  },
  {
    id: "2",
    firstName: "Jane",
    lastName: "Smith",
    email: "jane.smith@example.com",
    phone: "+41792345678",
    address: {
      street: "456 Oak Ave",
      city: "Zurich",
      postalCode: "8000",
      country: "CH",
    },
    donations: {
      lastDate: "2025-03-20",
      lastAmount: 100,
      totalAmount: 500,
      count: 5,
      recurring: false,
    },
    tags: ["newsletter"],
    createdAt: "2023-06-15T00:00:00Z",
  },
  {
    id: "3",
    firstName: "Robert",
    lastName: "Johnson",
    email: "robert.j@example.com",
    phone: "+33612345678",
    address: {
      street: "789 Rue de la Paix",
      city: "Paris",
      postalCode: "75001",
      country: "FR",
    },
    donations: {
      lastDate: "2024-12-01",
      lastAmount: 500,
      totalAmount: 1500,
      count: 3,
      recurring: true,
    },
    tags: ["vip", "volunteer"],
    createdAt: "2022-11-20T00:00:00Z",
  },
];

/**
 * Sample filter conditions for testing
 */
export const sampleConditions: Record<string, FilterCondition> = {
  cityGeneva: {
    id: "test-1",
    field: "address.city",
    operator: "eq",
    value: "Geneva",
  },
  amountGte100: {
    id: "test-2",
    field: "donations.lastAmount",
    operator: "gte",
    value: 100,
  },
  recurringTrue: {
    id: "test-3",
    field: "donations.recurring",
    operator: "eq",
    value: true,
  },
  emailContains: {
    id: "test-4",
    field: "email",
    operator: "contains",
    value: "@example.com",
  },
  dateRange2025: {
    id: "test-5",
    field: "donations.lastDate",
    operator: "between",
    value: ["2025-01-01", "2025-12-31"],
  },
  countrySwiss: {
    id: "test-6",
    field: "address.country",
    operator: "eq",
    value: "CH",
  },
  tagsVip: {
    id: "test-7",
    field: "tags",
    operator: "contains",
    value: ["vip"],
  },
  phoneExists: {
    id: "test-8",
    field: "phone",
    operator: "exists",
    value: null,
  },
};

/**
 * Sample filter queries for testing
 */
export const sampleQueries: Record<string, FilterQuery> = {
  empty: {
    operator: "AND",
    conditions: [],
  },
  simple: {
    operator: "AND",
    conditions: [sampleConditions.cityGeneva],
  },
  medium: {
    operator: "AND",
    conditions: [
      sampleConditions.cityGeneva,
      sampleConditions.amountGte100,
      sampleConditions.recurringTrue,
    ],
  },
  complex: {
    operator: "OR",
    conditions: [
      {
        operator: "AND",
        conditions: [sampleConditions.countrySwiss, sampleConditions.amountGte100],
      },
      {
        operator: "AND",
        conditions: [sampleConditions.tagsVip, sampleConditions.recurringTrue],
      },
    ],
  },
  withInvalid: {
    operator: "AND",
    conditions: [
      { id: "invalid-1", field: "", operator: "eq", value: "" },
      // @ts-expect-error Testing invalid operator
      { id: "invalid-2", field: "email", operator: "invalid", value: "test" },
    ],
  },
};

/**
 * Sample filter presets for testing
 */
export const samplePresets: FilterPreset[] = [
  {
    id: "recent-donors",
    name: "Recent Donors",
    description: "Donors who gave in the last 30 days",
    query: {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "donations.lastDate",
          operator: "gte",
          value: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        },
      ],
    },
  },
  {
    id: "high-value",
    name: "High Value Donors",
    description: "Donors with total donations over 1000",
    query: {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "donations.totalAmount",
          operator: "gte",
          value: 1000,
        },
      ],
    },
  },
  {
    id: "swiss-recurring",
    name: "Swiss Recurring Donors",
    description: "Recurring donors from Switzerland",
    query: {
      operator: "AND",
      conditions: [sampleConditions.countrySwiss, sampleConditions.recurringTrue],
    },
  },
];

/**
 * Sample filter chip data for testing
 */
export const sampleChips: FilterChipData[] = [
  {
    id: "chip-1",
    label: "City",
    field: "address.city",
    operator: "eq",
    value: "Geneva",
  },
  {
    id: "chip-2",
    label: "Last donation",
    field: "donations.lastAmount",
    operator: "gte",
    value: 100,
  },
  {
    id: "chip-3",
    label: "Recurring donor",
    field: "donations.recurring",
    operator: "eq",
    value: true,
  },
];

/**
 * Mock translations for testing
 */
export const mockTranslations: Record<string, string> = {
  title: "Filter Constituents",
  description: "Build complex queries to find specific constituents",
  operator: "Match",
  "operator.AND": "all conditions",
  "operator.OR": "any condition",
  addCondition: "Add condition",
  noConditions: "No conditions added yet",
  addFirstCondition: "Add your first condition",
  addAnotherCondition: "Add another condition",
  "preview.label": "Preview",
  "preview.loading": "Loading...",
  "preview.result": "{count} constituents match",
  "preview.error": "Error loading preview",
  apply: "Apply Filters",
  cancel: "Cancel",
  "error.incompleteConditions": "Please complete all conditions",
  "error.invalidQuery": "Invalid filter query",
  presetApplied: "Applied preset: {name}",
  "validation.fieldRequired": "Field is required",
  "validation.valueRequired": "Value is required",
  "validation.dateRangeInvalid": "End date must be after start date",
  "validation.numberRangeInvalid": "End value must be greater than start value",
};

/**
 * Create a mock filter field configuration
 */
export function createMockField(overrides?: Partial<FilterField>): FilterField {
  return {
    name: "testField",
    label: "Test Field",
    type: "text",
    category: "demographics",
    operators: ["eq", "ne", "contains"],
    ...overrides,
  };
}

/**
 * Create a mock filter condition
 */
export function createMockCondition(overrides?: Partial<FilterCondition>): FilterCondition {
  return {
    id: `condition-${Date.now()}`,
    field: "email",
    operator: "contains",
    value: "@example.com",
    ...overrides,
  };
}

/**
 * Create a mock filter query
 */
export function createMockQuery(
  conditions: FilterCondition[] = [],
  operator: "AND" | "OR" = "AND",
): FilterQuery {
  return {
    operator,
    conditions,
  };
}

/**
 * Mock API response for constituent fetch
 */
export function mockConstituentResponse(filters?: FilterQuery) {
  // Simple filtering logic for tests
  let filtered = [...mockConstituents];

  if (filters && filters.conditions.length > 0) {
    // Basic implementation - in real tests you'd match the actual filtering
    filtered = filtered.slice(0, 2);
  }

  return {
    constituents: filtered,
    total: filtered.length,
    page: 1,
    pageSize: 20,
  };
}

/**
 * Wait for async updates in tests
 */
export function waitForAsync(ms: number = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
