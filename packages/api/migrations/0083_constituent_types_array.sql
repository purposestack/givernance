-- Migration: 0083_constituent_types_array (issue #465)
--
-- Moves `constituents.type` from a single-value picklist to a multi-valued
-- `types text[]` array so a constituent can be a donor AND a volunteer AND a
-- beneficiary at once.
--
-- Strategy — ADDITIVE, no hard cutover:
--   1. ADD `types text[] NOT NULL DEFAULT '{donor}'`.
--   2. Backfill every existing row: `types = ARRAY[type]`.
--   3. GIN index so `types && ARRAY[...]` overlap filters stay index-backed.
--   4. KEEP the legacy `type` column. The service writes it as `types[0]` on
--      every create/update so an un-migrated reader (old container mid-rollout,
--      a forgotten query) never 500s. A FOLLOW-UP migration drops `type` once
--      every reader consumes `types`.
--
-- `IF NOT EXISTS` on the column + index keeps the DDL re-runnable. The
-- backfill needs no such guard: it runs exactly once (Drizzle's journal
-- applies each migration a single time), immediately after the column is
-- created and BEFORE any code can write multi-valued `types` — so lifting
-- every row's legacy scalar into a one-element array is unconditionally
-- correct. (The `'{donor}'` literal lives only on the column DEFAULT below,
-- mirroring the legacy `type` column's own `DEFAULT 'donor'`.)

ALTER TABLE constituents
  ADD COLUMN IF NOT EXISTS types text[] NOT NULL DEFAULT '{donor}'::text[];

-- Backfill: lift each row's legacy single value into the array.
UPDATE constituents
SET types = ARRAY[type]
WHERE type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_constituents_types
  ON constituents USING gin (types);
