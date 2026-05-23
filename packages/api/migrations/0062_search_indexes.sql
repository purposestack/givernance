-- Migration: 0062_search_indexes
--
-- Indexes that back the global search / command-palette endpoint
-- (Epic #364, GLO-001, `GET /v1/search`).
--
-- Strategy is documented in docs/29-global-search.md §3:
--   - Postgres FTS via `to_tsvector('simple', …)` IMMUTABLE expressions
--     over name / description fields, indexed with GIN. We use the
--     'simple' configuration (not 'french' / 'english') so the search
--     is language-agnostic — Givernance tenants mix French and English
--     constituent records and we don't want a French stemmer eating
--     English surnames or vice versa. Word-boundary tokenisation is
--     enough for a quick-jump command palette; recall is high, and
--     ranking is tightened by an entity-type weight + recency boost
--     in the service layer (NOT here).
--   - `pg_trgm` GIN indices on short, frequently-mistyped fields
--     (constituent first/last name, campaign name) so a user typing
--     "marie clair" still finds "Marie-Claire". `pg_trgm` is already
--     enabled by migration 0007.
--
-- Why expression indices instead of generated columns: keeping the
-- tsvector OUT of the table schema means Drizzle's introspection is
-- untouched and we don't pay write-amplification on every constituents
-- UPDATE that doesn't actually change a search-relevant field. Trade-
-- off: the SELECT must re-evaluate the same expression in the WHERE
-- clause (matching the index) — the service layer is the only caller
-- and uses the exact expression.
--
-- `IMMUTABLE`: required for an expression index. `to_tsvector(regconfig, …)`
-- is marked IMMUTABLE in Postgres only when the regconfig is a literal
-- (not a variable); the literal form below satisfies that.

-- ─── Constituents: name + email + city, simple FTS ───────────────────────────
CREATE INDEX IF NOT EXISTS "constituents_search_tsv_idx"
  ON "constituents"
  USING GIN (
    to_tsvector(
      'simple',
      coalesce("first_name", '') || ' ' ||
      coalesce("last_name", '') || ' ' ||
      coalesce("email", '') || ' ' ||
      coalesce("city", '')
    )
  );

-- ─── Constituents: trigram on first_name + last_name (typo tolerance) ────────
-- The combined column lets a single index serve both "marie clair" and
-- "fontaine marie" queries. `gin_trgm_ops` is what makes `ILIKE '%foo%'`
-- index-backed.
CREATE INDEX IF NOT EXISTS "constituents_name_trgm_idx"
  ON "constituents"
  USING GIN (
    (coalesce("first_name", '') || ' ' || coalesce("last_name", '')) gin_trgm_ops
  );

-- ─── Campaigns: name + description, simple FTS ───────────────────────────────
CREATE INDEX IF NOT EXISTS "campaigns_search_tsv_idx"
  ON "campaigns"
  USING GIN (
    to_tsvector(
      'simple',
      coalesce("name", '') || ' ' || coalesce("description", '')
    )
  );

-- ─── Campaigns: trigram on name (typo tolerance on short strings) ────────────
CREATE INDEX IF NOT EXISTS "campaigns_name_trgm_idx"
  ON "campaigns"
  USING GIN ("name" gin_trgm_ops);
