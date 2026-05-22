import { type FilterPreset } from "./filter-types";

/**
 * Pre-defined filter templates for common nonprofit use cases.
 * These match industry-standard queries like LYBUNT, SYBUNT, etc.
 */
export const FILTER_PRESETS: FilterPreset[] = [
  // Donation-based filters
  {
    id: "lybunt",
    key: "lybunt",
    name: "LYBUNT",
    description: "Last Year But Unfortunately Not This Year - Donated last year but not this year",
    category: "donation",
    icon: "TrendingDown",
    conditions: [
      {
        id: "lybunt-1",
        field: "lastDonationAt",
        operator: "between",
        value: ["lastYear.start", "lastYear.end"], // Will be computed dynamically
        label: "Donated last year",
      },
      {
        id: "lybunt-2",
        field: "lastDonationAt",
        operator: "not_in_last_days",
        value: 365, // Current year
        label: "No donation this year",
      },
    ],
    logic: "AND",
  },
  {
    id: "sybunt",
    key: "sybunt",
    name: "SYBUNT", 
    description: "Some Year But Unfortunately Not This Year - Has donated before but not this year",
    category: "donation",
    icon: "UserMinus",
    conditions: [
      {
        id: "sybunt-1",
        field: "lastDonationAt",
        operator: "is_not_null",
        value: null,
        label: "Has donated before",
      },
      {
        id: "sybunt-2",
        field: "lastDonationAt",
        operator: "not_in_last_days",
        value: 365,
        label: "No donation this year",
      },
    ],
    logic: "AND",
  },
  {
    id: "major-donors",
    key: "major-donors",
    name: "Major Donors",
    description: "Donors who have given €500 or more in total",
    category: "donation",
    icon: "Trophy",
    conditions: [
      {
        id: "major-1",
        field: "totalDonations",
        operator: "greater_than_or_equal",
        value: 500,
        label: "Total donations ≥ €500",
      },
    ],
    logic: "AND",
  },
  {
    id: "recurring-donors",
    key: "recurring-donors",
    name: "Recurring Monthly Donors",
    description: "Active monthly recurring donors",
    category: "donation",
    icon: "RefreshCw",
    conditions: [
      {
        id: "recurring-1",
        field: "tags",
        operator: "contains",
        value: "recurring-monthly",
        label: "Tagged as recurring monthly",
      },
    ],
    logic: "AND",
  },
  {
    id: "new-donors",
    key: "new-donors",
    name: "New Donors",
    description: "First-time donors in the last 90 days",
    category: "donation",
    icon: "UserPlus",
    conditions: [
      {
        id: "new-1",
        field: "createdAt",
        operator: "in_last_days",
        value: 90,
        label: "Added in last 90 days",
      },
      {
        id: "new-2",
        field: "donationCount",
        operator: "equals",
        value: 1,
        label: "Exactly 1 donation",
      },
    ],
    logic: "AND",
  },
  {
    id: "lapsed-donors",
    key: "lapsed-donors",
    name: "Lapsed Donors",
    description: "No donation in 12+ months",
    category: "donation",
    icon: "UserX",
    conditions: [
      {
        id: "lapsed-1",
        field: "lastDonationAt",
        operator: "older_than_days",
        value: 365,
        label: "Last donation over 1 year ago",
      },
    ],
    logic: "AND",
  },

  // Geographic filters
  {
    id: "local-geneva",
    key: "local-geneva",
    name: "Local Supporters (Geneva)",
    description: "Constituents in the Geneva region",
    category: "demographic",
    icon: "MapPin",
    conditions: [
      {
        id: "geneva-1",
        field: "postalCode",
        operator: "starts_with",
        value: "12",
        label: "Geneva postal codes (12xx)",
      },
    ],
    logic: "AND",
  },
  {
    id: "swiss-residents",
    key: "swiss-residents", 
    name: "Swiss Residents",
    description: "All constituents in Switzerland",
    category: "demographic",
    icon: "Flag",
    conditions: [
      {
        id: "swiss-1",
        field: "countryCode",
        operator: "equals",
        value: "CH",
        label: "Country is Switzerland",
      },
    ],
    logic: "AND",
  },

  // Engagement filters
  {
    id: "no-email",
    key: "no-email",
    name: "Missing Email",
    description: "Constituents without email addresses",
    category: "engagement",
    icon: "MailX",
    conditions: [
      {
        id: "no-email-1",
        field: "email",
        operator: "is_null",
        value: null,
        label: "Email is empty",
      },
    ],
    logic: "AND",
  },
  {
    id: "complete-contact",
    key: "complete-contact",
    name: "Complete Contact Info",
    description: "Has both email and phone",
    category: "engagement",
    icon: "CheckCircle",
    conditions: [
      {
        id: "complete-1",
        field: "email",
        operator: "is_not_null",
        value: null,
        label: "Has email",
      },
      {
        id: "complete-2",
        field: "phone",
        operator: "is_not_null",
        value: null,
        label: "Has phone",
      },
    ],
    logic: "AND",
  },
  {
    id: "volunteers",
    key: "volunteers",
    name: "Volunteers",
    description: "All volunteer constituents",
    category: "engagement",
    icon: "Heart",
    conditions: [
      {
        id: "volunteer-1",
        field: "type",
        operator: "equals",
        value: "volunteer",
        label: "Type is Volunteer",
      },
    ],
    logic: "AND",
  },
];

/** Get preset by key */
export function getPresetByKey(key: string): FilterPreset | undefined {
  return FILTER_PRESETS.find((preset) => preset.key === key);
}

/** Get presets by category */
export function getPresetsByCategory(category: string): FilterPreset[] {
  return FILTER_PRESETS.filter((preset) => preset.category === category);
}

/** Dynamic date calculation helpers */
export function calculateDateRange(range: string): [string, string] | string {
  const now = new Date();
  const year = now.getFullYear();
  
  switch (range) {
    case "lastYear.start":
      return `${year - 1}-01-01`;
    case "lastYear.end":
      return `${year - 1}-12-31`;
    case "thisYear.start":
      return `${year}-01-01`;
    case "thisYear.end":
      return `${year}-12-31`;
    default:
      return range;
  }
}