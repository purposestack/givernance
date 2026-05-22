# API Design for Advanced Constituent Filters

This document details the API design for the advanced filtering system, including endpoints, request/response schemas, and query structure.

## Filter Query Language

The filter system uses a tree-based structure that can express complex boolean logic with nested AND/OR groups.

### Basic Structure

```typescript
interface FilterGroup {
  id: string;                    // Unique identifier for UI tracking
  type: 'AND' | 'OR';           // Boolean operator for this group
  rules: FilterRule[];          // Direct filter rules
  groups: FilterGroup[];        // Nested groups (max depth: 3)
}

interface FilterRule {
  id: string;                   // Unique identifier for UI tracking
  field: string;                // Field to filter on
  operator: string;             // Comparison operator
  value: any;                   // Value(s) to compare against
}
```

### Example Filter

Find major donors who gave last year but not this year:

```json
{
  "type": "AND",
  "rules": [
    {
      "field": "lifetimeAmountCents",
      "operator": "greaterThanOrEqual",
      "value": 100000
    },
    {
      "field": "lastDonationDate", 
      "operator": "between",
      "value": {
        "start": "2025-01-01",
        "end": "2025-12-31"
      }
    },
    {
      "field": "lastDonationDate",
      "operator": "notBetween", 
      "value": {
        "start": "2026-01-01",
        "end": "2026-12-31"
      }
    }
  ],
  "groups": []
}
```

## API Endpoints

### 1. Get Available Filter Fields

```http
GET /v1/constituents/filters/fields
```

Returns metadata about all available filter fields.

**Response:**
```json
{
  "fields": [
    {
      "name": "firstName",
      "type": "string",
      "category": "constituent",
      "label": "First Name",
      "description": "Constituent's first name",
      "operators": ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "isEmpty", "isNotEmpty"]
    },
    {
      "name": "lifetimeAmountCents",
      "type": "number",
      "category": "donations",
      "label": "Lifetime Giving",
      "description": "Total amount donated (cleared minus refunded)",
      "operators": ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isEmpty"]
    },
    {
      "name": "lastDonationDate",
      "type": "date",
      "category": "donations", 
      "label": "Last Donation Date",
      "description": "Date of most recent donation",
      "operators": ["equals", "notEquals", "before", "after", "between", "inLastXDays", "notInLastXDays", "isEmpty"]
    },
    {
      "name": "type",
      "type": "enum",
      "category": "constituent",
      "label": "Constituent Type",
      "description": "Type of constituent",
      "operators": ["equals", "notEquals", "inList", "notInList"],
      "enumValues": ["donor", "volunteer", "member", "beneficiary"]
    },
    {
      "name": "hasEmail",
      "type": "boolean",
      "category": "constituent",
      "label": "Has Email Address",
      "description": "Whether constituent has an email on file",
      "operators": ["isTrue", "isFalse"]
    }
  ],
  "categories": [
    {
      "name": "constituent",
      "label": "Constituent Information",
      "description": "Basic constituent fields"
    },
    {
      "name": "donations", 
      "label": "Donation History",
      "description": "Donation-related filters"
    },
    {
      "name": "engagement",
      "label": "Engagement",
      "description": "Communication and activity filters"
    }
  ]
}
```

### 2. Preview Filter Results

Get a preview of filter results without loading full data.

```http
POST /v1/constituents/filters/preview
```

**Request:**
```json
{
  "filter": {
    "type": "AND",
    "rules": [
      {
        "field": "hasEmail",
        "operator": "isTrue",
        "value": null
      },
      {
        "field": "lastDonationDate",
        "operator": "inLastXDays",
        "value": 365
      }
    ],
    "groups": []
  },
  "limit": 10
}
```

**Response:**
```json
{
  "totalCount": 234,
  "executionTimeMs": 127,
  "preview": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "firstName": "Marie",
      "lastName": "Dubois",
      "email": "marie.dubois@example.com",
      "lastDonationDate": "2026-04-15",
      "lifetimeAmountCents": 50000
    }
    // ... up to 10 results
  ]
}
```

### 3. Execute Filter

Execute a filter with full pagination and sorting.

```http
POST /v1/constituents/filters/execute
```

**Request:**
```json
{
  "filter": {
    "type": "OR",
    "rules": [],
    "groups": [
      {
        "type": "AND",
        "rules": [
          {
            "field": "type",
            "operator": "equals",
            "value": "donor"
          },
          {
            "field": "lifetimeAmountCents",
            "operator": "greaterThan",
            "value": 100000
          }
        ]
      },
      {
        "type": "AND", 
        "rules": [
          {
            "field": "type",
            "operator": "equals", 
            "value": "volunteer"
          },
          {
            "field": "tags",
            "operator": "contains",
            "value": "board_member"
          }
        ]
      }
    ]
  },
  "page": 1,
  "perPage": 50,
  "sort": "lastName",
  "order": "asc",
  "includeStats": true
}
```

**Response:**
```json
{
  "data": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "firstName": "Marie",
      "lastName": "Dubois", 
      "email": "marie.dubois@example.com",
      "phone": "+33 6 12 34 56 78",
      "type": "donor",
      "tags": ["major_donor", "gala_2025"],
      "hasCompleteAddress": true,
      "createdAt": "2020-01-15T10:30:00Z",
      "lastDonationDate": "2026-04-15",
      "donationCount": 24,
      "lifetimeAmountCents": 125000,
      "averageGiftCents": 5208
    }
    // ... more results
  ],
  "pagination": {
    "page": 1,
    "perPage": 50,
    "total": 234,
    "totalPages": 5
  },
  "stats": {
    "totalLifetimeValue": 29250000,
    "averageLifetimeValue": 125000,
    "totalConstituents": 234
  },
  "executionTimeMs": 156
}
```

### 4. Save Filter

Save a filter configuration for reuse.

```http
POST /v1/constituents/filters/saved
```

**Request:**
```json
{
  "name": "Major Donors - LYBUNT",
  "description": "Major donors who gave last year but not this year",
  "filterConfig": {
    "type": "AND",
    "rules": [
      {
        "field": "lifetimeAmountCents",
        "operator": "greaterThanOrEqual", 
        "value": 100000
      },
      {
        "field": "isLYBUNT",
        "operator": "isTrue",
        "value": null
      }
    ]
  }
}
```

**Response:**
```json
{
  "id": "456e7890-e89b-12d3-a456-426614174000",
  "orgId": "789e0123-e89b-12d3-a456-426614174000",
  "name": "Major Donors - LYBUNT",
  "description": "Major donors who gave last year but not this year",
  "filterConfig": { /* ... */ },
  "isSystem": false,
  "createdBy": "012e3456-e89b-12d3-a456-426614174000",
  "createdAt": "2026-05-22T10:30:00Z",
  "updatedAt": "2026-05-22T10:30:00Z"
}
```

### 5. List Saved Filters

```http
GET /v1/constituents/filters/saved
```

**Query Parameters:**
- `includeSystem` (boolean): Include pre-built system filters

**Response:**
```json
{
  "data": [
    {
      "id": "sys_lybunt",
      "name": "LYBUNT",
      "description": "Gave last year but not this year",
      "isSystem": true,
      "category": "recency"
    },
    {
      "id": "456e7890-e89b-12d3-a456-426614174000",
      "name": "Major Donors - LYBUNT",
      "description": "Major donors who gave last year but not this year",
      "isSystem": false,
      "createdBy": "012e3456-e89b-12d3-a456-426614174000",
      "createdAt": "2026-05-22T10:30:00Z",
      "lastUsedAt": "2026-05-20T14:22:00Z",
      "useCount": 5
    }
  ]
}
```

### 6. Apply Filter to Campaign

Bulk add constituents to a campaign using a filter.

```http
POST /v1/campaigns/:campaignId/constituents/bulk-add
```

**Request:**
```json
{
  "source": "filter",
  "filter": {
    "type": "AND",
    "rules": [
      {
        "field": "hasCompleteAddress",
        "operator": "isTrue", 
        "value": null
      },
      {
        "field": "type",
        "operator": "equals",
        "value": "donor"
      }
    ]
  },
  "options": {
    "skipExisting": true,
    "limit": 1000
  }
}
```

**Alternative - using saved filter:**
```json
{
  "source": "savedFilter",
  "savedFilterId": "456e7890-e89b-12d3-a456-426614174000",
  "options": {
    "skipExisting": true
  }
}
```

**Response:**
```json
{
  "added": 156,
  "skipped": 23,
  "errors": 0,
  "executionTimeMs": 340
}
```

## Special Filter Fields

### Computed Fields

These fields are calculated at query time:

#### isLYBUNT
```json
{
  "field": "isLYBUNT",
  "operator": "isTrue",
  "value": null
}
```

#### isSYBUNT  
```json
{
  "field": "isSYBUNT",
  "operator": "isTrue",
  "value": null
}
```

#### isNewDonor
New donor within specified days (default 90):
```json
{
  "field": "isNewDonor",
  "operator": "isTrue",
  "value": { "days": 90 }
}
```

#### donorCategory
Automatic categorization based on giving:
```json
{
  "field": "donorCategory",
  "operator": "equals",
  "value": "major" // or "mid", "small"
}
```

### Complex Value Types

#### Date Ranges
```json
{
  "field": "lastDonationDate",
  "operator": "between",
  "value": {
    "start": "2026-01-01",
    "end": "2026-12-31"
  }
}
```

#### Relative Dates
```json
{
  "field": "lastDonationDate", 
  "operator": "inLastXDays",
  "value": 30
}
```

#### List Values
```json
{
  "field": "tags",
  "operator": "containsAnyOf",
  "value": ["major_donor", "board_member", "volunteer"]
}
```

#### Campaign References
```json
{
  "field": "hasDonatedToCampaign",
  "operator": "equals",
  "value": {
    "campaignId": "789e0123-e89b-12d3-a456-426614174000",
    "dateRange": {
      "start": "2026-01-01",
      "end": "2026-12-31"
    }
  }
}
```

## Error Responses

### Invalid Filter Structure
```json
{
  "type": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422",
  "title": "Invalid filter structure",
  "status": 422,
  "detail": "Filter groups cannot be nested more than 3 levels deep",
  "errors": {
    "filter.groups[0].groups[0].groups[0]": ["Maximum nesting depth exceeded"]
  }
}
```

### Unknown Field
```json
{
  "type": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422", 
  "title": "Unknown filter field",
  "status": 422,
  "detail": "Field 'unknownField' is not a valid filter field",
  "errors": {
    "filter.rules[0].field": ["Invalid field name"]
  }
}
```

### Invalid Operator for Field Type
```json
{
  "type": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422",
  "title": "Invalid operator",
  "status": 422, 
  "detail": "Operator 'contains' cannot be used with numeric field 'lifetimeAmountCents'",
  "errors": {
    "filter.rules[0].operator": ["Invalid operator for field type"]
  }
}
```

### Query Timeout
```json
{
  "type": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/504",
  "title": "Query timeout",
  "status": 504,
  "detail": "Filter query exceeded maximum execution time of 5 seconds"
}
```

## Rate Limiting

Filter operations are rate-limited to prevent abuse:

- Filter preview: 60 requests per minute
- Filter execute: 30 requests per minute  
- Bulk operations: 10 requests per minute

Rate limit headers:
```http
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 28
X-RateLimit-Reset: 1653926400
```

## Performance Considerations

1. **Query Complexity**: Filters are limited to 50 rules and 3 levels of nesting
2. **Result Limits**: Maximum 10,000 results per query
3. **Timeout**: Queries timeout after 5 seconds
4. **Caching**: Results cached for 5 minutes with same filter

## Webhooks

Optional webhooks for filter operations:

```json
{
  "event": "filter.executed",
  "data": {
    "filterId": "456e7890-e89b-12d3-a456-426614174000",
    "resultCount": 234,
    "executionTimeMs": 156,
    "executedBy": "012e3456-e89b-12d3-a456-426614174000"
  }
}
```