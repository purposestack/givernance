-- Migration: 0040_postal_export_idempotency
-- Epic #274 audit follow-up — worker idempotency + mission length cap.
--
-- Two unrelated tightenings rolled into one migration so the audit fixes
-- ship as a single deploy:
--
--   1. `campaign_qr_codes.export_id` — links each minted QR token to the
--      `campaign_postal_exports` row that produced it. Lets the worker
--      detect on retry that QR codes have already been generated for
--      this export and reuse them, instead of duplicating tokens in
--      the DB on every BullMQ retry (Kamal pod crash mid-export).
--
--      Nullable: existing rows pre-dating this column have no export
--      backlink (manual-printed campaigns from the legacy flow), and
--      future ad-hoc QR generators may bypass the export pipeline.
--
--      A partial unique index on `(export_id, COALESCE(constituent_id, '00000000-0000-0000-0000-000000000000'::uuid))`
--      enforces "one QR per (export, recipient)" so a concurrent retry
--      cannot produce duplicates even if the application-level dedup
--      check loses a race. The COALESCE trick is necessary because
--      Postgres treats NULLs as distinct in unique indexes — door-drop
--      exports have NULL constituent_id, and we want exactly one such
--      row per export.
--
--   2. `tenants.mission` capped at 1000 chars. The validator already
--      soft-caps at 2000 (and now drops to 1000 to match), but the
--      DB-level CHECK gives defence-in-depth: it stops a future code
--      path that bypasses the validator (raw SQL migration, admin
--      console, ETL import) from leaking a multi-megabyte free-form
--      blob into the postal-letter renderer.
--
-- Idempotent — uses `IF NOT EXISTS` / `DO $$ BEGIN ... EXCEPTION` guards
-- so re-runs on a fresh checkout are no-ops.

-- ─── 1. campaign_qr_codes.export_id ─────────────────────────────────────────

ALTER TABLE campaign_qr_codes
  ADD COLUMN IF NOT EXISTS export_id UUID
    REFERENCES campaign_postal_exports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS campaign_qr_codes_export_id_idx
  ON campaign_qr_codes (export_id);

-- Partial unique: one QR row per (export, recipient). The COALESCE
-- collapses NULL constituent_id to a sentinel so door-drop exports
-- (one row, NULL recipient) cannot accumulate duplicates on retry.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_qr_codes_export_recipient_uniq
  ON campaign_qr_codes (
    export_id,
    COALESCE(constituent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE export_id IS NOT NULL;

-- ─── 2. tenants.mission length cap ──────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE tenants
    ADD CONSTRAINT tenants_mission_length_chk
    CHECK (mission IS NULL OR char_length(mission) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
