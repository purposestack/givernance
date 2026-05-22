# Advanced Filters Architecture

This document outlines the technical architecture for implementing advanced constituent filters in Givernance, enabling NPOs to build sophisticated donor segments for campaign targeting.

## Overview

The advanced filter system will provide a flexible, performant way to query constituents based on donation history, engagement metrics, demographics, and custom criteria. The architecture follows Givernance's existing patterns while introducing new capabilities for complex queries.

## Core Components

### 1. Filter Query Builder (Frontend)

#### Component Structure
```
components/
  constituents/
    filters/
      FilterBuilder.tsx          # Main container component
      FilterGroup.tsx           # AND/OR group container
      FilterRule.tsx            # Individual filter rule
      FilterField.tsx           # Field selector dropdown
      FilterOperator.tsx        # Operator selector (is, is not, >, <, etc.)
      FilterValue.tsx           # Value input (dynamic based on field type)
      SavedFilters.tsx          # Saved filter management
```

#### Key Features
- Nested AND/OR groups for complex queries
- Dynamic field/operator/value selection based on field type
- Visual query preview showing estimated results count
- Save/load filter configurations
- Export filter results

### 2. Filter Schema & Types

```typescript
// packages/shared/src/types/filters.ts

export interface FilterRule {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: FilterValue;
}

export interface FilterGroup {
  id: string;
  type: 'AND' | 'OR';
  rules: FilterRule[];
  groups: FilterGroup[];
}

export interface SavedFilter {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  filterConfig: FilterGroup;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type FilterField = 
  // Constituent fields
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'hasEmail'
  | 'hasCompleteAddress'
  | 'type'
  | 'tags'
  | 'createdAt'
  // Donation aggregates
  | 'lastDonationDate'
  | 'firstDonationDate'
  | 'donationCount'
  | 'lifetimeAmountCents'
  | 'averageGiftCents'
  | 'largestGiftCents'
  | 'daysSinceLastGift'
  // Donation details
  | 'hasDonatedToCampaign'
  | 'donationPaymentMethod'
  | 'donationPaymentSource'
  // Recurring
  | 'hasActiveRecurring'
  | 'recurringStatus'
  // Special segments
  | 'isLYBUNT'
  | 'isSYBUNT'
  | 'isNewDonor'
  | 'donorCategory';

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'between'
  | 'inList'
  | 'notInList'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse'
  | 'inDateRange'
  | 'inLastXDays'
  | 'notInLastXDays';
```

### 3. Database Schema Extensions

```sql
-- Saved filters table
CREATE TABLE saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  filter_config JSONB NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE, -- For pre-built filters
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  UNIQUE (org_id, name)
);

-- Filter execution history for analytics
CREATE TABLE filter_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filter_id UUID REFERENCES saved_filters(id) ON DELETE SET NULL,
  filter_config JSONB NOT NULL, -- Snapshot of filter at execution
  result_count INTEGER NOT NULL,
  execution_time_ms INTEGER NOT NULL,
  executed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for common aggregate queries
CREATE INDEX idx_donations_constituent_donated_at ON donations(constituent_id, donated_at);
CREATE INDEX idx_donations_constituent_amount ON donations(constituent_id, amount_base_cents);
CREATE INDEX idx_constituents_email_not_null ON constituents(org_id) WHERE email IS NOT NULL;
CREATE INDEX idx_constituents_complete_address ON constituents(org_id) 
  WHERE address_line1 IS NOT NULL 
    AND postal_code IS NOT NULL 
    AND city IS NOT NULL 
    AND country_code IS NOT NULL;
```

### 4. API Layer

#### New Endpoints

```typescript
// GET /v1/constituents/filters/preview
// Preview filter results without full data
{
  filter: FilterGroup,
  limit?: number // For preview, default 10
}
Response: {
  totalCount: number,
  preview: ConstituentListRow[],
  executionTimeMs: number
}

// POST /v1/constituents/filters/execute  
// Execute filter and get full results
{
  filter: FilterGroup,
  page: number,
  perPage: number,
  sort?: string,
  order?: 'asc' | 'desc'
}

// GET /v1/constituents/filters/saved
// List saved filters for the organization

// POST /v1/constituents/filters/saved
// Save a new filter configuration

// GET /v1/constituents/filters/fields
// Get available fields and their metadata for the query builder
Response: {
  fields: Array<{
    name: string,
    type: 'string' | 'number' | 'date' | 'boolean' | 'enum',
    operators: FilterOperator[],
    enumValues?: string[],
    description: string
  }>
}

// POST /v1/campaigns/:id/constituents/bulk
// Bulk add constituents to campaign using filter
{
  filter?: FilterGroup,
  constituentIds?: string[] // Direct IDs or filter
}
```

### 5. Query Engine Implementation

```typescript
// packages/api/src/modules/constituents/filter-engine.ts

export class ConstituentFilterEngine {
  constructor(private db: Database, private orgId: string) {}

  async executeFilter(filter: FilterGroup): Promise<ConstituentListRow[]> {
    const query = this.buildQuery(filter);
    return await query.execute();
  }

  private buildQuery(group: FilterGroup): QueryBuilder {
    // Convert filter tree to SQL with proper joins and aggregations
    // Handle special cases like LYBUNT which need fiscal year context
  }

  private handleDonationAggregates(field: FilterField): SQL {
    // Build subqueries for donation-based filters
    // Use CTEs for complex aggregations
  }

  private optimizeQuery(query: QueryBuilder): QueryBuilder {
    // Apply query optimizations based on filter complexity
    // Use materialized views for common expensive calculations
  }
}
```

### 6. Performance Optimizations

#### Materialized Views for Common Aggregates

```sql
-- Constituent donation summary materialized view
CREATE MATERIALIZED VIEW constituent_donation_summary AS
SELECT 
  c.id as constituent_id,
  c.org_id,
  COUNT(d.id) as donation_count,
  COALESCE(SUM(d.amount_base_cents), 0) as lifetime_amount_cents,
  COALESCE(AVG(d.amount_base_cents), 0) as average_gift_cents,
  MAX(d.amount_base_cents) as largest_gift_cents,
  MAX(d.donated_at) as last_donation_date,
  MIN(d.donated_at) as first_donation_date,
  CURRENT_DATE - MAX(d.donated_at)::date as days_since_last_gift
FROM constituents c
LEFT JOIN donations d ON c.id = d.constituent_id 
  AND d.status = 'cleared'
WHERE c.deleted_at IS NULL
GROUP BY c.id, c.org_id;

-- Refresh strategy: daily via cron job
CREATE INDEX idx_donation_summary_org_constituent 
  ON constituent_donation_summary(org_id, constituent_id);
```

#### Query Result Caching

- Use Redis to cache filter results for 5 minutes
- Key: `filter:${orgId}:${filterHash}`
- Invalidate on constituent/donation changes

### 7. Pre-built System Filters

Provide common filters out-of-the-box:

```typescript
const SYSTEM_FILTERS = [
  {
    name: 'LYBUNT',
    description: 'Gave last year but not this year',
    filterConfig: {
      type: 'AND',
      rules: [
        {
          field: 'lastDonationDate',
          operator: 'inDateRange',
          value: { start: lastYearStart, end: lastYearEnd }
        },
        {
          field: 'lastDonationDate',
          operator: 'notInDateRange', 
          value: { start: thisYearStart, end: today }
        }
      ]
    }
  },
  // ... more pre-built filters
];
```

## Security Considerations

1. **Row-Level Security**: All queries automatically scoped to user's organization
2. **Query Complexity Limits**: Prevent DoS via deeply nested filters
3. **Execution Time Limits**: Kill queries exceeding 5 seconds
4. **Rate Limiting**: Limit filter executions per organization
5. **Audit Trail**: Log all filter executions with results count

## Migration Strategy

### Phase 1: Read-Only Filters
- Implement filter UI and query engine
- No saved filters yet
- Focus on core donor segmentation use cases

### Phase 2: Saved Filters & Bulk Actions
- Add saved filter functionality
- Enable bulk add to campaigns
- Add filter sharing within organization

### Phase 3: Advanced Features
- Filter templates marketplace
- Scheduled filter execution for alerts
- AI-powered filter suggestions
- Export to external tools

## Integration Points

### Campaign Members
- Replace current simple search with advanced filters
- "Add members using filter" action
- Show filter criteria on campaign for transparency

### Bulk Email
- Target recipients using saved filters
- Exclude previous recipients using filters

### Reporting
- Use filter engine for custom report segments
- Track filter usage analytics

### Future: Automation
- Trigger actions when constituents match/unmatch filters
- Dynamic campaign membership based on filters

## Testing Strategy

1. **Unit Tests**: Filter query builder logic
2. **Integration Tests**: Complex filter scenarios with real data
3. **Performance Tests**: Large dataset handling (100k+ constituents)
4. **E2E Tests**: Full flow from UI to results

## Monitoring

- Filter execution times (P50, P95, P99)
- Most used filter criteria
- Failed filter executions
- Cache hit rates
- Query plan analysis for optimization