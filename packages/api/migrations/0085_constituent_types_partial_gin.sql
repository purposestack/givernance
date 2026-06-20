-- Issue #465 (review follow-up) — make the constituent `types` GIN index
-- partial, matching every sibling index on `constituents`
-- (`idx_constituents_tags`, `idx_constituents_type`, `idx_constituents_location`,
-- `idx_constituents_email_domain` in 0063) which are all `WHERE deleted_at IS NULL`.
--
-- 0083 created `idx_constituents_types` over the whole table. Every list /
-- filter query that uses the array-overlap operator also carries
-- `deleted_at IS NULL`, so a full index (a) bloats with soft-deleted rows the
-- planner can never use, and (b) is less likely to be chosen for the live-row
-- overlap query for lack of the partial-predicate match. 0083 is immutable
-- once applied, so this re-creates the index additively rather than editing it.

DROP INDEX IF EXISTS idx_constituents_types;

CREATE INDEX IF NOT EXISTS idx_constituents_types
  ON constituents USING GIN(types)
  WHERE deleted_at IS NULL;
