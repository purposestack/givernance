# ADR-036: Custom Fields — Per-Org JSONB Column + Registry over EAV, Per-Tenant DDL, and Custom Objects

**Status**: Accepted  
**Date**: 2026-07-20  
**Deciders**: MVP Engineer Team  
**Epic**: #539

## Context

Mid-size NPOs (2–5 M€ budgets) disqualify Givernance for lacking customization: typed custom fields per organization and per domain, evolving picklists, and cross-domain visibility of that custom data. The reference competitors solve this in ways we explicitly refuse to copy: Salesforce provisions **per-tenant DDL** (real columns and custom objects per org — the root of its €75k–275k implementation TCO, its ~110-custom-object cap, and the ">50 % of custom fields unused" sprawl), while classic CRM EAV designs (one `values` table with `entity_id, field_id, value`) trade schema stability for unreadable queries and broken indexing.

Constraints that shaped the decision:

- **Multi-tenant Postgres with forced RLS** — any design must keep the single-schema, `org_id`-scoped model intact (issue #430: explicit `eq(orgId)` everywhere, RLS as safety net).
- **The advanced-filter engine (ADR-033)** already resolves fields through a per-request registry — custom fields must join that seam, not fork it.
- **GDPR**: operators will put PII — potentially Art. 9 special-category data — into fields the platform cannot anticipate. Redaction, purpose records, erasure, and projection fencing must be structural.
- **Anti-sprawl product stance**: quotas and governance are the selling point ("configured in an afternoon by your own staff"), so the engine must be deliberately closed, not maximally flexible.

## Decision

We store custom-field **values** in **one JSONB column per domain table** (`constituents.custom`, `donations.custom`, `campaigns.custom` — `NOT NULL DEFAULT '{}'`, GIN `jsonb_path_ops`) and custom-field **metadata** in a per-org **registry table** (`custom_field_definitions`) that every write validates against and every read serializes through.

### Architecture Choices

1. **JSONB + registry, never per-tenant DDL**: tenants share one schema forever; a "field" is a registry row, and creating one is an `INSERT`, not a migration.
2. **Closed 8-type set** (`text`, `long_text`, `number`, `date`, `boolean`, `picklist`, `multi_picklist`, `currency`), immutable per definition — type change is archive + recreate (a partial unique index on `(org_id, domain, key) WHERE archived_at IS NULL` makes archived keys re-creatable).
3. **Embedded picklist options with stable ids**: options live as a JSONB array on the definition row (`{id: 'opt_*', label, active, sortOrder, mergedInto?}`); **values store option ids, never labels** — rename-in-place is free, deactivation is a flag, and merge is the only operation that rewrites stored values (chunked, audited, 30-day undoable via `custom_field_merge_undo`).
4. **Definition-driven serialization as the response firewall**: no response ever passes the stored blob through; serializers pick exactly the keys the chosen definition set names (active / projectable / exportable), and TypeBox schemas stay `additionalProperties: false`.
5. **Quota governance in code + a governed override table**: published per-plan limits (`CUSTOM_FIELD_QUOTAS`) with hard platform ceilings; raises live in `customization_quota_overrides` (super-admin, mandatory reason, SELECT-only for the app role) — never in an edited constant.
6. **Registry catalog cached 60 s** (`customfields:{orgId}:{domain}`) + unlink-on-mutation — deliberately under the 1-minute threshold that would trigger the issue-#449 flush-route obligation.

### Value encoding (the key structure)

```jsonc
// constituents.custom / donations.custom / campaigns.custom
{
  "segment_donateur": "opt_a1b2c3d4",          // picklist → option id, never the label
  "regions": ["opt_x1y2z3w4", "opt_q5r6s7t8"], // multi_picklist → deduped id array
  "membre_conseil": true,                      // boolean
  "premiere_rencontre": "2026-03-14",          // date → 'YYYY-MM-DD' string
  "cotisation_annuelle": 5000                  // currency → integer cents, org base currency
}
// Absent key ≡ null ≡ "is empty" — null never persists; writing null/""/[] clears the key.
```

### Database Strategy

- **GIN `jsonb_path_ops`** per domain table (partial `WHERE deleted_at IS NULL` on constituents) — serves the `@>` containment the filter engine emits for picklist/boolean equality; the smaller operator class wins because the engine only ever emits containment.
- **Number/date ranges run as unindexed cast expressions** — acceptable at NPO scale; **per-field expression indexes are the documented escape hatch**, a deliberate per-key migration, never automatic.
- **DB CHECKs back the 422s**: key regex, `sensitive ⇒ purpose_text`, `show_on_related ⇒ (constituent ∧ ¬sensitive)`, quota-key enum, non-blank override reason.
- All three new tables: RLS enabled + forced, plus explicit `eq(orgId)` in every query (issue #430).

## Consequences

### Positive

- **Field creation is a row insert** — an org admin self-serves in minutes; zero migrations, zero deploy coupling, zero per-tenant schema drift.
- **One shared schema** keeps RLS, backups, migrations, and the dual-role test harness (issue #455) exactly as they are.
- **Rename-never-delete picklists**: stable ids make the common lifecycle operations (rename, deactivate, reorder) metadata-only; only merge touches data, and it is dry-runnable, chunked, audited, and undoable.
- **The filter engine extends instead of forking**: per-org definitions merge into the ADR-033 field registry as `custom.<key>` entries; the DSL never carries column names.
- **GDPR posture is structural**: sensitive fields are fenced by DB CHECK + per-request eligibility, values are redacted from logs/audit by path, and erasure is a `custom = '{}'` set (plus the sensitive-strip on donations) — no per-tenant DDL to chase.

### Negative

- **No relational integrity inside the blob**: an option id or key referenced by a value is validated at write time only; definition archive leaves orphaned-but-preserved values by design (read-only on detail/exports).
- **Range queries are unindexed** until a per-field expression index is deliberately added; a pathological tenant could breach the filter p95 budget.
- **Typed access is mediated**: everything reading `custom` must go through the validator/serializer seam — a raw `SELECT custom` is easy to write and wrong.
- **JSONB blobs bloat rows** if quotas were ever removed — the quota ceilings are load-bearing for storage, not just UX.
- **Cache-key deviation from the epic** (Epic #539 § 4): the epic specified `catalog_version`-keyed cache entries (per-org monotonic counter in the key); shipped instead as fixed per-domain keys (`customfields:{orgId}:{domain}`) + explicit `UNLINK` on every definition mutation + a 60 s TTL backstop. Behaviourally equivalent (worst-case staleness = one TTL window; zero when invalidation fires) with no version counter to persist — but anyone extending the cache must keep calling `invalidateDefinitionsCache` on every mutation path, since there is no version bump to save them. The invalidation contract is pinned by an integration test (docs/35 § 3).

### Mitigation

- The value-service (`getActiveDefinitions` / `validateCustomPatch` / `buildCustomSerializer` / `getProjectableDefinitions`) is the **only** sanctioned seam; whole-blob passthrough is a blocking review finding (docs/35 § 6 reviewer checklist).
- JSONB range-query load test in Phase 2; the expression-index escape hatch is pre-documented with an owner and a trigger threshold to be set (Epic #539 open question #9).
- Hard platform ceilings (50 fields/domain, 100 options, 5 projected) + `customization_quota_overrides` keep blob size and catalog size bounded.

## Alternatives Considered

### 1. Per-tenant DDL (the Salesforce model — real columns / custom objects per org)
- **Rejected**: migration storms across thousands of tenants, per-tenant schema drift, catalog bloat, incompatible with forced-RLS single-schema topology — and it is precisely the TCO/sprawl machine this product positions against.

### 2. EAV tables (`custom_field_values(entity_id, field_id, value)`)
- **Rejected**: every read becomes an N-way self-join or aggregation, typed comparisons need per-type value columns or casts, indexing is worse than GIN containment, and row-explosion makes RLS and erasure sweeps costlier. JSONB gives the same schemalessness with one column and one index.

### 3. Separate normalized picklist tables (`custom_field_options` as rows)
- **Rejected** (for v1): options are only ever read with their definition; embedding them keeps the catalog a single cached row-set and avoids a join on every form render. Reusable org-level option sets are an explicit revisit criterion (Epic #539 open question #7) — a future extraction is additive.

### 4. Custom objects / user-defined collections
- **Rejected — binding anti-goal #1**: no bounded collections, no `domain='collection:<id>'` hack, no polymorphic `parent_id`. Real workflow domains (grants, bequests, in-kind valuations) ship as first-class typed domains with their own epics — each with `custom` JSONB support from day one.

### 5. Whole-blob full-text search (`jsonb_to_tsvector`) for Cmd+K
- **Rejected — judge veto**: it would index sensitive values regardless of flags. Custom fields are filter-only in this epic; the only acceptable future mechanisms are per-field expression indexes or an explicit non-sensitive allowlist generated column.

## Implementation Notes

### Phase 1 (Engine core)
- Migrations `0086`–`0089`: registry + enums + RLS, quota-overrides (app-role SELECT-only) + merge-undo store, three `custom` columns + GIN, three per-domain flag seeds (default-off).
- Shared package `@givernance/shared/custom-fields` (web-safe): types, quotas, `RESERVED_KEYS`, `buildCustomValidator`.
- Definitions/options CRUD + value merge-patch paths + redaction/erasure wiring + admin UI.

### Phase 2 (Projection & pipelines)
- Cross-domain projection (`donorCustom`, cap 5, per-request eligibility), filter-registry integration, CSV export, bulk-import template 1.1 (`cf_<key>` aliases), option merge + usage endpoint with `'< 5'` masking.

### Phase 3 / 4 (out of the core wedge)
- Advisory tags governance (`tag_registry`, derived) and the propose-only AI schema steward (`ai_suggestions`, template-constrained payloads, EU inference only) — separate flags, separate PRs.

## References

- [Epic #539](https://github.com/purposestack/givernance/issues/539) — multi-agent architecture study (2026-07-17), 3 competing designs, judge vetoes
- [docs/35-customization.md](../35-customization.md) — the domain contract this ADR anchors
- [ADR-033](./adr-033-advanced-filter-architecture.md) / [docs/30-advanced-filters.md](../30-advanced-filters.md) — the filter registry extended here
- [docs/18-feature-flags.md](../18-feature-flags.md) · issue #430 (explicit `eq(orgId)`) · issue #455 (dual-role tests) · issue #449 (cache-flush rule)
- Competitor analysis: Salesforce NPSP implementation TCO; Creatio "Battlecard: Salesforce vs. Creatio" (Nov 2025); Bloomerang typed custom fields
