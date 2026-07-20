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

1. **types.ts**: TypeScript interfaces and the static core field registry
2. **field-registry.ts**: Two-layer per-org registry (Epic #539) — merges the org's filterable custom-field definitions (`custom.<key>`) over the static core registry, plus the archived-key set for named 400s
3. **query-builder.ts**: Converts filter DSL to Drizzle ORM queries (regular-column, aggregate, and custom-JSONB lanes)
4. **pattern-detector.ts**: Implements special donor pattern detection
5. **filter.service.ts**: Business logic and orchestration
6. **filter.routes.ts**: FastAPI route handlers

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

## Custom fields (Epic #539)

When `constituents.custom_fields` is enabled for the org, every `filterable`
non-archived constituent-domain definition joins the registry as
`custom.<key>`:

- Routes fetch the merged registry per request (`getFieldRegistryBundle`) and
  pass it into `FilterService` — validation, execution, catalog, suggestions,
  and sort all resolve against the same map. The DSL never carries raw column
  names or JSON keys.
- SQL lanes: boolean / picklist / multi_picklist equality compile to
  `custom @> …` containment (served by the `jsonb_path_ops` GIN index);
  text runs `custom->>'k' ILIKE`; number / currency / date run as cast
  expressions (currency reuses the EUR→cents `valueUnit` normalization,
  date reuses the end-of-day bounds).
- All custom fields offer `isNull` / `isNotNull` ("is empty" ≡ key absent or
  stored JSON null).
- A query referencing an ARCHIVED definition gets the named 400
  `custom_field_archived` (never a silent drop) — persisted campaign segments
  surface it explicitly.
- `GET /v1/constituents/filter/fields` is per-org and enriched: `label`,
  `labelKind` (`literal` for operator-authored custom labels, `i18n` for core
  keys), `category` (`custom` for custom fields), `uiType`, `options`,
  `valueUnit`, `nullable`. With no definitions the payload is the enriched
  core set — zero behaviour change.
- Suggestions: custom text fields run `SELECT DISTINCT custom->>'k'`;
  picklists answer client-side from `options` (no DB hit).
- Scope v1: constituent-domain definitions only; the flag off ⇒ custom fields
  disappear from the registry entirely (validate as unknown fields).

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