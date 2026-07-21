# ADR-033: Advanced Constituent Filter Architecture

**Status**: Accepted — extended to a second domain (donations), see Addendum  
**Date**: 2026-05-22 (addendum 2026-07-21)  
**Deciders**: MVP Engineer Team  
**Epic**: #418 (constituents) · donations follow-up (flag `donations.advanced_filters`)

## Context

NPOs need to segment constituents for targeted campaigns using complex criteria like "donors who gave last year but not this year" (LYBUNT) or "recurring monthly donors in Geneva". The current implementation only supports basic text search.

Operators are forced to manually select constituents one by one, which doesn't scale beyond a few dozen recipients. Industry standard tools like Salesforce NPSP provide sophisticated filtering, setting user expectations.

## Decision

We will implement a **client-side filter builder** with **server-side query execution** using a flexible Domain Specific Language (DSL) that can express complex constituent queries.

### Architecture Choices

1. **Query DSL over SQL**: A JSON-based query language that abstracts database complexity
2. **Stateless API**: Each filter request is independent, no server-side session state
3. **Materialized views**: Pre-calculate expensive metrics like lifetime value
4. **Progressive enhancement**: Start with basic filters, add complexity incrementally

### Query Structure
```typescript
{
  operator: 'AND' | 'OR',
  conditions: [{
    field: 'donations.lastDate',
    operator: 'between',
    value: ['2025-01-01', '2025-12-31']
  }]
}
```

### Component Architecture
- **FilterBuilder**: Main container orchestrating the filter UI
- **FilterChip**: Visual representation of active filters
- **FilterPresets**: Pre-defined templates for common queries
- **Query Builder Service**: Translates DSL to optimized SQL

### Database Strategy
- Strategic indexes on common filter paths
- Materialized view for constituent metrics
- Query result caching for repeated filters
- Background processing for large exports

## Consequences

### Positive
- **User empowerment**: Operators can create sophisticated segments without SQL knowledge
- **Performance**: Materialized views make complex queries fast
- **Extensibility**: New filter types can be added without schema changes
- **Reusability**: Filters can be saved and shared across the team

### Negative
- **Complexity**: Query builder adds significant frontend/backend complexity
- **Index proliferation**: Many indexes needed for performance
- **Cache invalidation**: Materialized views need refresh strategy
- **Learning curve**: Advanced features may overwhelm new users

### Mitigation
- Progressive disclosure in UI (simple → advanced)
- Pre-built templates for common use cases
- Query performance monitoring and alerts
- Comprehensive documentation and training

## Alternatives Considered

### 1. Direct SQL Builder
- **Rejected**: Security risk, requires SQL knowledge, hard to validate

### 2. GraphQL with Filtering
- **Rejected**: Over-complex for use case, requires GraphQL expertise

### 3. Fixed Filter Options
- **Rejected**: Too limiting, doesn't meet NPO segment complexity

### 4. Third-party Service
- **Rejected**: Data sovereignty concerns, integration complexity

## Implementation Notes

### Phase 1 (MVP)
- Core filter UI components
- Basic donation and demographic filters  
- 5-6 pre-defined templates
- Real-time count preview

### Phase 2
- Save/load filters
- Complex nested conditions
- Export functionality
- Performance optimizations

### Phase 3
- Natural language queries via LLM
- Predictive analytics
- API access for external tools

## Addendum (2026-07-21) — second domain instance validates the architecture

This ADR was written for a single domain (constituents), and some of its
framing was constituent-specific. The donations list has since received the
same treatment ([`docs/30-advanced-filters.md`](../30-advanced-filters.md) §9,
flag `donations.advanced_filters`), and the port is the empirical test of the
decision. What we learned:

**What transposed unchanged** — the domain-agnostic core:

- The JSON query DSL (`FilterQuery` / `FilterCondition`, AND/OR + nested
  groups) and its complexity caps (≤10 conditions, depth ≤3).
- The server-side **field registry** pattern: the wire carries DSL names only,
  column resolution happens against a per-domain registry. Standing up a new
  domain = writing a new registry (`modules/donations/filters/field-registry.ts`),
  not touching the engine.
- The generic operator switch, value normalization (EUR→cents, end-of-day
  upper bounds), ILIKE escaping, and the whole `validateQuery` block —
  consumed by the donations module **as imports from
  `modules/constituents/filters/`, with zero modifications** to the
  constituents engine (its test suites run untouched).
- The API posture: catalog + debounced count-preview endpoints, shareable
  `?filters=` URL param on the list route, flag-gated 404-when-off.

**What is constituent-specific, not architectural** (a new domain must decide
these per-domain rather than inherit them):

- The **aggregate lane and pattern detection** (LYBUNT/SYBUNT/…) summarize a
  donor's giving — they exist because constituents are the *person* grain.
  Donations are the *row* grain, so the donations instance has no aggregates
  and rejects `patterns` with 400. Per-row `EXISTS` lanes (fund allocation,
  receipt state, pledge linkage) took their place.
- The **materialized-view strategy** (constituent metrics) is an optimization
  for the aggregate lane, not part of the core architecture; the donations
  instance ships without one.
- **Preset templates** are a product decision per domain — the donations v1
  deliberately ships none.

**Consequence for future domains** (campaigns, communications, …): treat
`modules/constituents/filters/` as the de-facto shared engine consumed via
imports. If a third domain instance appears, extract the generic core
(types, operator switch, validation) into `packages/shared` or a common API
lib at that point — two consumers did not yet justify the churn, three would.

## References

- [Epic #418](https://github.com/purposestack/givernance/issues/418)
- [NPO Glossary](../glossary-npo.md)
- [Advanced Filters Documentation](../30-advanced-filters.md)
- Salesforce NPSP documentation
- Industry analysis of Bloomerang, Blackbaud