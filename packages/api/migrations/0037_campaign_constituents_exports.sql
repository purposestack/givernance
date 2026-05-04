-- Migration: 0037_campaign_constituents_exports
-- Epic #274 — Postal campaigns MVP.
--
-- Adds two tables:
--   1. `campaign_constituents` — explicit linkage between a campaign and the
--      constituents on its mailing list. Lets the org build a recipient list
--      for a postal campaign WITHOUT creating placeholder donations (the
--      workaround discussed in #233 / #274).
--   2. `campaign_export_jobs` — orchestration record for the asynchronous
--      ZIP archive generation pipeline. The HTTP request returns immediately
--      with the job id; the BullMQ worker fans out PDF generation, bundles
--      the result, uploads the archive to S3, and progressively updates
--      `progress_total` / `progress_done`. The frontend polls the job
--      resource to drive a progress bar.
--
-- Both tables follow the standard tenant-isolation posture: org_id FK with
-- ON DELETE CASCADE, RLS policy on `app.current_org_id`, and explicit grants
-- to the `givernance_app` role. Idempotent (matches 0033/0034 conventions).

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE campaign_export_job_status AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_export_mode AS ENUM ('door_drop', 'nominative');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Campaign Constituents ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_constituents (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id       UUID         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  constituent_id    UUID         NOT NULL REFERENCES constituents(id) ON DELETE CASCADE,
  added_by_user_id  UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_constituents_org_id_idx
  ON campaign_constituents (org_id);
CREATE INDEX IF NOT EXISTS campaign_constituents_campaign_id_idx
  ON campaign_constituents (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_constituents_constituent_id_idx
  ON campaign_constituents (constituent_id);

-- One row per (campaign, constituent) — re-attaching is a no-op via
-- INSERT ... ON CONFLICT DO NOTHING in the service layer.
ALTER TABLE campaign_constituents
  DROP CONSTRAINT IF EXISTS campaign_constituents_campaign_constituent_uniq;
ALTER TABLE campaign_constituents
  ADD CONSTRAINT campaign_constituents_campaign_constituent_uniq
  UNIQUE (campaign_id, constituent_id);

-- ─── Campaign Export Jobs ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_export_jobs (
  id                    UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID                          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id           UUID                          NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  requested_by_user_id  UUID                          REFERENCES users(id) ON DELETE SET NULL,
  mode                  campaign_export_mode          NOT NULL,
  status                campaign_export_job_status    NOT NULL DEFAULT 'pending',
  progress_total        INTEGER                       NOT NULL DEFAULT 0,
  progress_done         INTEGER                       NOT NULL DEFAULT 0,
  archive_s3_path       VARCHAR(500),
  error                 TEXT,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ                   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ                   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_export_jobs_org_id_idx
  ON campaign_export_jobs (org_id);
CREATE INDEX IF NOT EXISTS campaign_export_jobs_campaign_id_idx
  ON campaign_export_jobs (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_export_jobs_status_idx
  ON campaign_export_jobs (status);

-- Progress counters cannot be negative; done cannot exceed total. These
-- guard rails catch a buggy worker before the front-end progress bar
-- shows nonsense values.
ALTER TABLE campaign_export_jobs DROP CONSTRAINT IF EXISTS campaign_export_jobs_progress_chk;
ALTER TABLE campaign_export_jobs
  ADD CONSTRAINT campaign_export_jobs_progress_chk
  CHECK (progress_total >= 0 AND progress_done >= 0 AND progress_done <= progress_total);

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE campaign_constituents ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_constituents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_constituents;
CREATE POLICY tenant_isolation ON campaign_constituents
  USING (org_id = app_current_organization_id());

ALTER TABLE campaign_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_export_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_export_jobs;
CREATE POLICY tenant_isolation ON campaign_export_jobs
  USING (org_id = app_current_organization_id());

-- ─── Grant permissions to app role ─────────────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'givernance_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_constituents TO givernance_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_export_jobs TO givernance_app';
  END IF;
END $$;
