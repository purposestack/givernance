-- 0043 — Convert org_branding_assets numeric columns from JSONB to INTEGER.
--
-- Migration 0042 declared `original_bytes`, `source_width`, and
-- `source_height` as JSONB on the rationale that "integer-jsonb gives
-- consistent serialisation across nullable fields". PR #287 review
-- (major 7) flagged the rationale as hand-wavy: `integer()` is nullable
-- by default in Drizzle, the columns only ever hold integers, and
-- JSONB blocks every future plan-gating SQL aggregate (`SUM(original_bytes)`
-- to enforce a per-tenant logo storage cap, `AVG(source_width)` for
-- layout diagnostics) without an `::int` cast on every read.
--
-- The conversion is in-place via `ALTER COLUMN ... USING (col::text)::int`
-- so any rows already inserted under JSONB shape (a single integer
-- literal serialises as e.g. `1234`) round-trip cleanly. No data is at
-- risk: in Phase 1 the table is freshly added, the only writers are the
-- branding upload pipeline + worker, and both emit raw integer values.
--
-- Idempotent — `DO $$ BEGIN ... EXCEPTION WHEN ... END $$;` per the
-- migration 0041 pattern. Re-runs against an already-converted column
-- are no-ops (`undefined_column` short-circuits when the SQL planner
-- already sees an INTEGER type, but PostgreSQL emits `cannot_coerce` /
-- `datatype_mismatch` for redundant casts on already-typed columns; we
-- catch both to keep the migration robust against partial replays).

DO $$ BEGIN
  ALTER TABLE org_branding_assets
    ALTER COLUMN original_bytes TYPE INTEGER USING (original_bytes::text)::int;
EXCEPTION
  WHEN cannot_coerce THEN NULL;
  WHEN datatype_mismatch THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE org_branding_assets
    ALTER COLUMN source_width TYPE INTEGER USING (source_width::text)::int;
EXCEPTION
  WHEN cannot_coerce THEN NULL;
  WHEN datatype_mismatch THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE org_branding_assets
    ALTER COLUMN source_height TYPE INTEGER USING (source_height::text)::int;
EXCEPTION
  WHEN cannot_coerce THEN NULL;
  WHEN datatype_mismatch THEN NULL;
END $$;
