# Advanced Constituent Filters

This module implements advanced filtering capabilities for constituents as specified in Issue #422.

## Features

- **Complex Query DSL**: Support for AND/OR logical operators with nested conditions
- **Field Operators**: eq, neq, gt, gte, lt, lte, between, in, contains, startsWith, endsWith, arrayContains, arrayOverlaps, isNull, isNotNull
- **Aggregation Support**: Filter by donation totals, counts, averages, and date ranges
- **Pattern Detection**:
  - LYBUNT: Last Year But Unfortunately Not This
  - SYBUNT: Some Year But Unfortunately Not This  
  - RECURRING: Donors with regular giving patterns
  - LAPSED: Donors who haven't given recently
  - MAJOR_DONOR: High-value contributors

## Architecture

### Components

1. **types.ts**: TypeScript interfaces and field registry
2. **query-builder.ts**: Converts filter DSL to Drizzle ORM queries
3. **pattern-detector.ts**: Implements special donor pattern detection
4. **filter.service.ts**: Business logic and orchestration
5. **filter.routes.ts**: FastAPI route handlers

### API Endpoints

- `POST /v1/constituents/filter` - Execute filter and return results
- `POST /v1/constituents/filter/preview` - Get count only (performance optimization)
- `GET /v1/constituents/filter/suggestions` - Autocomplete for field values
- `POST /v1/campaigns/:id/members/filter` - Add filtered constituents to campaign
- `GET /v1/constituents/filter/fields` - Get field metadata

### Database

Migration `0058_add_filter_indexes.sql` adds performance indexes:
- Constituent location queries
- Donation aggregations
- Tag array operations
- Pattern detection queries

## Usage Example

```typescript
// Filter donors in New York who gave over 1000 EUR
const query = {
  operator: "AND",
  conditions: [
    { field: "constituent.type", operator: "eq", value: "donor" },
    { field: "address.city", operator: "eq", value: "New York" },
    { field: "donations.totalAmount", operator: "gte", value: 100000 }
  ]
};

// Detect LYBUNT donors
const lybuntQuery = {
  operator: "AND",
  conditions: [],
  patterns: ["LYBUNT"]
};
```

## Performance Considerations

- Uses database indexes for common query patterns
- Preview endpoint for count-only queries
- Pagination support to limit result sets
- Query complexity validation to prevent abuse

## Feature Flag

Protected by `advanced_filters` feature flag:
- Scope: tenant
- Default: false
- Tenant override allowed: true

Enable via Back Office or tenant settings when ready for production use.

## Testing

Integration tests in `packages/api/src/tests/integration/filters.test.ts` cover:
- Basic field filtering
- Array operations
- Aggregation queries
- Pattern detection
- Campaign integration
- Error handling
- Feature flag enforcement