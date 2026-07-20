-- Migration: 0088_domain_custom_columns (Epic #539; docs/35)
--
-- Value storage for custom fields: ONE JSONB column per domain table,
-- never per-tenant DDL (Epic #539 §3.2). The blob maps definition key →
-- value, validated at write time against `custom_field_definitions`
-- (migration 0086). Absent key ≡ null ≡ "is empty" — the blob never
-- stores nulls. `DEFAULT '{}'` + NOT NULL keeps every reader
-- null-check-free; on Postgres 11+ the ADD COLUMN with a constant
-- default is a catalog-only change (no table rewrite).
--
-- Index strategy: GIN `jsonb_path_ops` serves the `@>` containment
-- queries the filter engine emits for picklist / boolean equality.
-- Number/date range predicates run as unindexed cast expressions —
-- acceptable at NPO scale (load-tested in Phase 2); per-field expression
-- indexes are a documented, deliberate escape hatch, never automatic.
-- `jsonb_path_ops` (not the default `jsonb_ops`) because the engine
-- only ever emits containment — the smaller/faster operator class wins.
--
-- The constituents index is PARTIAL on `deleted_at IS NULL`, matching
-- the soft-delete predicate every constituent query carries (same
-- pattern as 0085_constituent_types_partial_gin). Donations and
-- campaigns have no soft-delete column — unconditional indexes.

ALTER TABLE constituents ADD COLUMN custom JSONB NOT NULL DEFAULT '{}';
ALTER TABLE donations    ADD COLUMN custom JSONB NOT NULL DEFAULT '{}';
ALTER TABLE campaigns    ADD COLUMN custom JSONB NOT NULL DEFAULT '{}';

CREATE INDEX constituents_custom_gin_idx
  ON constituents USING GIN (custom jsonb_path_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX donations_custom_gin_idx
  ON donations USING GIN (custom jsonb_path_ops);

CREATE INDEX campaigns_custom_gin_idx
  ON campaigns USING GIN (custom jsonb_path_ops);
