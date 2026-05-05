-- 0041 — Cap `campaigns.description` to 2000 characters.
--
-- The PDF renderer flows the operator's description verbatim into the
-- postal letter body. Migration 0038 added the column without a length
-- guard; migration 0040 added a 1000-char `CHECK` to `tenants.mission`
-- but left `campaigns.description` unbounded. A raw-SQL insert or an
-- ETL importer (Salesforce migration tool) could push a multi-megabyte
-- string that the PDFKit renderer would emit verbatim and OOM the
-- worker process — a denial-of-service vector against the export queue.
--
-- 2000 chars is roughly 25–35 lines of justified body text, comfortably
-- larger than the operator-form soft cap (the form already limits
-- input to 2000) but small enough to fit on a single A4 panel without
-- pagination. Mirrors the `tenants.mission` posture: form-level cap +
-- DB-level CHECK as defense-in-depth.
--
-- Idempotent — `DO $$ BEGIN ... EXCEPTION` so re-runs on a fresh
-- checkout are no-ops.

DO $$ BEGIN
  ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_description_length_chk
    CHECK (description IS NULL OR char_length(description) <= 2000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
