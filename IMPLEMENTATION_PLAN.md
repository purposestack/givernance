# Implementation Plan for Advanced Filters

This document provides a step-by-step implementation guide for adding advanced constituent filters to Givernance. The plan is broken into small, implementable chunks that can be delivered incrementally.

## Phase 1: Foundation (2-3 weeks)

### Sprint 1: Core Infrastructure

#### Task 1.1: Database Schema & Migrations
**Priority**: P0
**Effort**: 3 points
**Dependencies**: None

```bash
# Create migration files
packages/migrate/migrations/00XX_add_saved_filters_table.sql
packages/migrate/migrations/00XX_add_constituent_indexes.sql
packages/migrate/migrations/00XX_add_donation_summary_view.sql
```

- Add `saved_filters` table
- Add `filter_executions` table
- Create constituent/donation indexes for performance
- Create materialized view for donation summaries
- Update schema types in `packages/shared/src/schema/index.ts`

#### Task 1.2: Shared Types & Constants
**Priority**: P0
**Effort**: 2 points
**Dependencies**: 1.1

Create TypeScript types:
```
packages/shared/src/types/filters.ts
packages/shared/src/constants/filter-fields.ts
packages/shared/src/constants/filter-operators.ts
```

- Define `FilterRule`, `FilterGroup`, `SavedFilter` types
- Define field metadata with types and allowed operators
- Create filter validation schemas

#### Task 1.3: Basic Filter Engine
**Priority**: P0
**Effort**: 5 points
**Dependencies**: 1.2

```
packages/api/src/modules/constituents/filter-engine.ts
packages/api/src/modules/constituents/filter-builder.ts
packages/api/src/modules/constituents/__tests__/filter-engine.test.ts
```

- Implement `ConstituentFilterEngine` class
- Convert filter AST to Drizzle queries
- Handle basic constituent fields (name, email, type, tags)
- Add comprehensive unit tests

### Sprint 2: API Layer

#### Task 2.1: Filter Preview Endpoint
**Priority**: P0  
**Effort**: 3 points
**Dependencies**: 1.3

```
POST /v1/constituents/filters/preview
```

- Accept filter configuration
- Return count + first 10 results
- Add execution time metrics
- Implement rate limiting

#### Task 2.2: Filter Execution Endpoint
**Priority**: P0
**Effort**: 3 points  
**Dependencies**: 2.1

```
POST /v1/constituents/filters/execute
```

- Full paginated results
- Support sorting
- Return execution metadata
- Log to `filter_executions` table

#### Task 2.3: Field Metadata Endpoint
**Priority**: P0
**Effort**: 2 points
**Dependencies**: 1.2

```
GET /v1/constituents/filters/fields
```

- Return available fields with types
- Include allowed operators per field
- Include field descriptions for UI
- Support field categories

#### Task 2.4: Error Handling & Validation
**Priority**: P0
**Effort**: 2 points
**Dependencies**: 2.1, 2.2

- Add proper error messages for invalid filters
- Implement query complexity limits
- Add execution timeouts
- Create custom error types

## Phase 2: Basic UI (2-3 weeks)

### Sprint 3: Filter Builder UI

#### Task 3.1: Filter Rule Component
**Priority**: P0
**Effort**: 3 points
**Dependencies**: Phase 1

```
packages/web/src/components/constituents/filters/FilterRule.tsx
packages/web/src/components/constituents/filters/FilterField.tsx
packages/web/src/components/constituents/filters/FilterOperator.tsx
packages/web/src/components/constituents/filters/FilterValue.tsx
```

- Implement single rule UI (field + operator + value)
- Dynamic value input based on field type
- Field/operator dropdowns with search
- Proper form validation

#### Task 3.2: Filter Group Component  
**Priority**: P0
**Effort**: 3 points
**Dependencies**: 3.1

```
packages/web/src/components/constituents/filters/FilterGroup.tsx
packages/web/src/components/constituents/filters/FilterBuilder.tsx
```

- AND/OR group containers
- Add/remove rules and groups
- Visual group nesting (max depth: 3)
- Drag and drop for reordering

#### Task 3.3: Integration with Campaign Members
**Priority**: P0
**Effort**: 5 points
**Dependencies**: 3.2

Update `CampaignMembersCard`:
- Add "Advanced Filter" mode toggle
- Replace simple search with filter builder
- Show applied filter summary
- Implement bulk add using filter

#### Task 3.4: Filter Preview & Results
**Priority**: P1
**Effort**: 3 points
**Dependencies**: 3.3

- Real-time result count preview
- Loading states and error handling
- Result list with selection
- Performance indicators

### Sprint 4: Donation Filters

#### Task 4.1: Donation Aggregate Fields
**Priority**: P0
**Effort**: 5 points
**Dependencies**: Sprint 3

Extend filter engine for:
- Last donation date
- Lifetime value
- Donation count
- Average gift size
- Days since last gift

#### Task 4.2: LYBUNT/SYBUNT Implementation
**Priority**: P0
**Effort**: 3 points
**Dependencies**: 4.1

- Add fiscal year context to filter engine
- Implement LYBUNT calculation
- Implement SYBUNT calculation  
- Add as pre-defined filter options

#### Task 4.3: Campaign-Specific Filters
**Priority**: P1
**Effort**: 3 points
**Dependencies**: 4.1

- "Has donated to campaign X"
- "Has NOT donated to campaign X"
- Multi-campaign donors
- Campaign date ranges

## Phase 3: Saved Filters & Polish (2-3 weeks)

### Sprint 5: Saved Filters

#### Task 5.1: Save Filter API
**Priority**: P1
**Effort**: 3 points
**Dependencies**: Phase 2

```
POST /v1/constituents/filters/saved
GET /v1/constituents/filters/saved
PUT /v1/constituents/filters/saved/:id
DELETE /v1/constituents/filters/saved/:id
```

- CRUD operations for saved filters
- Enforce unique names per org
- Add sharing permissions

#### Task 5.2: Saved Filters UI
**Priority**: P1
**Effort**: 5 points
**Dependencies**: 5.1

```
packages/web/src/components/constituents/filters/SavedFilters.tsx
packages/web/src/components/constituents/filters/SaveFilterDialog.tsx
```

- Save current filter with name/description
- Load saved filters dropdown
- Edit/delete saved filters
- Show last used timestamp

#### Task 5.3: Pre-built System Filters
**Priority**: P1
**Effort**: 3 points
**Dependencies**: 5.2

- Implement common filters (LYBUNT, Major Donors, etc.)
- Mark as system/read-only
- Organize by category
- Include in saved filters list

### Sprint 6: Advanced Features

#### Task 6.1: Complex Operators
**Priority**: P2
**Effort**: 3 points
**Dependencies**: Sprint 5

Add support for:
- "Between" operator for numeric/date ranges
- "In last X days" for dates
- "Contains any of" for multi-value
- Regular expression matching

#### Task 6.2: Export Functionality
**Priority**: P2
**Effort**: 3 points
**Dependencies**: Phase 2

- Export filtered results to CSV
- Include selected fields only
- Add to bulk actions menu
- Audit trail for exports

#### Task 6.3: Performance Optimization
**Priority**: P1
**Effort**: 5 points
**Dependencies**: All previous

- Implement Redis caching layer
- Add query result pagination
- Optimize complex queries
- Add performance monitoring

#### Task 6.4: Testing & Documentation
**Priority**: P0
**Effort**: 5 points
**Dependencies**: All previous

- E2E tests for critical flows
- Performance benchmarks
- User documentation
- API documentation

## Phase 4: Full Campaign Integration (1-2 weeks)

### Sprint 7: Campaign Features

#### Task 7.1: Bulk Operations
**Priority**: P1
**Effort**: 3 points
**Dependencies**: Phase 3

- Bulk add to campaign from constituents list
- Bulk remove using filters
- Bulk tag assignment
- Operation history/undo

#### Task 7.2: Filter-Based Segments
**Priority**: P2
**Effort**: 5 points
**Dependencies**: 7.1

- Save filter as campaign segment
- Auto-update segment members
- Segment statistics dashboard
- A/B testing support

## Technical Debt & Improvements

### Ongoing Tasks

1. **Query Optimization**
   - Monitor slow queries
   - Add missing indexes
   - Optimize materialized views

2. **Error Handling**
   - Improve error messages
   - Add retry logic
   - Better timeout handling

3. **Testing**
   - Increase test coverage to 80%+
   - Add performance regression tests
   - Regular load testing

4. **Documentation**
   - Keep API docs current
   - Add inline code comments
   - Create video tutorials

## Risk Mitigation

### Performance Risks
- **Risk**: Complex filters on large datasets timeout
- **Mitigation**: Query complexity limits, caching, pagination

### Security Risks
- **Risk**: Filter injection attacks
- **Mitigation**: Parameterized queries, input validation, allowlists

### UX Risks
- **Risk**: Filter builder too complex for users
- **Mitigation**: Progressive disclosure, pre-built filters, tooltips

## Success Metrics

1. **Performance**
   - 95% of filters execute in <2 seconds
   - Support 100k+ constituent databases

2. **Adoption**
   - 50% of campaigns use advanced filters
   - 10+ saved filters per active org

3. **Quality**
   - <0.1% error rate on filter execution
   - 80%+ test coverage

## Rollout Strategy

1. **Alpha** (Week 1-2)
   - Internal testing
   - Performance validation
   - Bug fixes

2. **Beta** (Week 3-4)  
   - Roll out to 10% of orgs
   - Gather feedback
   - Monitor performance

3. **GA** (Week 5)
   - Full rollout
   - Marketing announcement
   - Training materials

## Dependencies

### External
- Redis for caching (already in use)
- No new external services needed

### Internal  
- Coordinate with DevOps for Redis capacity
- UX review for filter builder
- Marketing for launch materials

## Future Enhancements

After MVP launch, consider:
1. Natural language filter builder
2. AI-powered filter suggestions
3. Scheduled filter alerts
4. Integration with email marketing tools
5. Predictive donor scoring