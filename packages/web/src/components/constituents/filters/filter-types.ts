/**
 * Type definitions for the constituent filter system.
 * 
 * This follows a composable filter architecture similar to Salesforce NPSP
 * but with a more intuitive UX for common nonprofit use cases.
 */

export type FilterOperator = 
  | "equals" 
  | "not_equals" 
  | "contains" 
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "greater_than" 
  | "less_than" 
  | "greater_than_or_equal"
  | "less_than_or_equal"
  | "between"
  | "in"
  | "not_in"
  | "is_null"
  | "is_not_null"
  | "in_last_days"
  | "not_in_last_days"
  | "in_next_days"
  | "older_than_days";

export type FilterFieldType = "text" | "number" | "date" | "boolean" | "enum" | "array";

export interface FilterField {
  key: string;
  label: string;
  type: FilterFieldType;
  operators: FilterOperator[];
  /** For enum fields, the available options */
  options?: Array<{ value: string; label: string }>;
  /** Help text for the field */
  description?: string;
  /** Field path in the constituent object */
  path?: string;
}

export interface FilterCondition {
  id: string;
  field: string;
  operator: FilterOperator;
  value: any;
  /** Display label for the condition */
  label?: string;
}

export type FilterLogic = "AND" | "OR";

export interface Filter {
  id: string;
  name?: string;
  description?: string;
  conditions: FilterCondition[];
  logic: FilterLogic;
  /** Nested filter groups for complex queries */
  groups?: Filter[];
}

export interface FilterPreset extends Filter {
  /** Unique identifier for the preset */
  key: string;
  /** Icon name (from lucide-react) */
  icon?: string;
  /** Category for grouping presets */
  category?: "donation" | "engagement" | "demographic" | "custom";
}

/** Available filter fields for constituents */
export const CONSTITUENT_FILTER_FIELDS: FilterField[] = [
  // Basic Info
  {
    key: "firstName",
    label: "First Name",
    type: "text",
    operators: ["equals", "not_equals", "contains", "starts_with", "ends_with"],
  },
  {
    key: "lastName",
    label: "Last Name",
    type: "text",
    operators: ["equals", "not_equals", "contains", "starts_with", "ends_with"],
  },
  {
    key: "email",
    label: "Email",
    type: "text",
    operators: ["equals", "not_equals", "contains", "is_null", "is_not_null"],
  },
  {
    key: "phone",
    label: "Phone",
    type: "text",
    operators: ["equals", "not_equals", "contains", "is_null", "is_not_null"],
  },
  
  // Address fields
  {
    key: "city",
    label: "City",
    type: "text",
    operators: ["equals", "not_equals", "contains", "is_null", "is_not_null"],
  },
  {
    key: "postalCode",
    label: "Postal Code",
    type: "text",
    operators: ["equals", "not_equals", "starts_with", "is_null", "is_not_null"],
  },
  {
    key: "countryCode",
    label: "Country",
    type: "enum",
    operators: ["equals", "not_equals", "in", "not_in", "is_null", "is_not_null"],
    options: [
      { value: "CH", label: "Switzerland" },
      { value: "FR", label: "France" },
      { value: "DE", label: "Germany" },
      { value: "IT", label: "Italy" },
      { value: "BE", label: "Belgium" },
      { value: "US", label: "United States" },
      { value: "GB", label: "United Kingdom" },
    ],
  },
  
  // Type and tags
  {
    key: "type",
    label: "Type",
    type: "enum",
    operators: ["equals", "not_equals", "in", "not_in"],
    options: [
      { value: "donor", label: "Donor" },
      { value: "volunteer", label: "Volunteer" },
      { value: "member", label: "Member" },
      { value: "beneficiary", label: "Beneficiary" },
      { value: "partner", label: "Partner" },
    ],
  },
  {
    key: "tags",
    label: "Tags",
    type: "array",
    operators: ["contains", "not_contains"],
  },
  
  // Donation-related (requires join)
  {
    key: "lastDonationAt",
    label: "Last Donation Date",
    type: "date",
    operators: [
      "greater_than",
      "less_than",
      "between",
      "is_null",
      "is_not_null",
      "in_last_days",
      "not_in_last_days",
      "older_than_days",
    ],
  },
  {
    key: "totalDonations",
    label: "Total Donations",
    type: "number",
    operators: [
      "equals",
      "not_equals",
      "greater_than",
      "less_than",
      "greater_than_or_equal",
      "less_than_or_equal",
      "between",
    ],
    description: "Lifetime donation amount",
  },
  {
    key: "donationCount",
    label: "Number of Donations",
    type: "number",
    operators: [
      "equals",
      "not_equals",
      "greater_than",
      "less_than",
      "greater_than_or_equal",
      "less_than_or_equal",
    ],
  },
  
  // Dates
  {
    key: "createdAt",
    label: "Created Date",
    type: "date",
    operators: [
      "greater_than",
      "less_than",
      "between",
      "in_last_days",
      "not_in_last_days",
    ],
  },
];

/** Helper to get field config by key */
export function getFieldConfig(key: string): FilterField | undefined {
  return CONSTITUENT_FILTER_FIELDS.find((f) => f.key === key);
}

/** Helper to format operator for display */
export function formatOperator(operator: FilterOperator): string {
  const operatorLabels: Record<FilterOperator, string> = {
    equals: "is",
    not_equals: "is not",
    contains: "contains",
    not_contains: "does not contain",
    starts_with: "starts with",
    ends_with: "ends with",
    greater_than: "greater than",
    less_than: "less than",
    greater_than_or_equal: "at least",
    less_than_or_equal: "at most",
    between: "between",
    in: "is one of",
    not_in: "is not one of",
    is_null: "is empty",
    is_not_null: "has value",
    in_last_days: "in last",
    not_in_last_days: "not in last",
    in_next_days: "in next",
    older_than_days: "older than",
  };
  return operatorLabels[operator] || operator;
}

/** Helper to generate a human-readable label for a condition */
export function generateConditionLabel(condition: FilterCondition): string {
  const field = getFieldConfig(condition.field);
  if (!field) return `${condition.field} ${formatOperator(condition.operator)} ${condition.value}`;
  
  let valueLabel = condition.value;
  
  // Format based on field type and operator
  if (condition.operator === "is_null" || condition.operator === "is_not_null") {
    return `${field.label} ${formatOperator(condition.operator)}`;
  }
  
  if (field.type === "enum" && field.options) {
    const option = field.options.find((opt) => opt.value === condition.value);
    valueLabel = option?.label || condition.value;
  }
  
  if (field.type === "date" && (condition.operator === "in_last_days" || condition.operator === "not_in_last_days" || condition.operator === "older_than_days")) {
    return `${field.label} ${formatOperator(condition.operator)} ${condition.value} days`;
  }
  
  if (field.type === "number" && condition.key === "totalDonations") {
    valueLabel = `€${condition.value}`;
  }
  
  if (condition.operator === "between" && Array.isArray(condition.value)) {
    return `${field.label} ${formatOperator(condition.operator)} ${condition.value[0]} and ${condition.value[1]}`;
  }
  
  return `${field.label} ${formatOperator(condition.operator)} ${valueLabel}`;
}