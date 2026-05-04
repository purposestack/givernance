-- Migration: 0037_postal_campaigns_mvp (Epic #274)
--
-- Postal-campaigns MVP additions:
--   * `campaign_constituents` join table — explicit membership of a
--     constituent in a campaign (independent of any document or donation).
--     The previous flow leaked membership through `campaign_documents.constituent_id`
--     which is fine for fan-out but useless for "who is this campaign
--     targeting before we generate anything?" UX.
--   * `campaign_postal_exports` — async ZIP-archive generation jobs.
--     Carries `mode`, `status`, `progress_count` / `total_count`, the
--     zip's `s3_path`, and the requesting user. The frontend polls this
--     row to render a progress bar; the worker mutates it as it streams
--     PDFs through the bundler. (Epic #274 comment 1.)
--   * `donations.qr_code_id` — nullable FK to `campaign_qr_codes` so a
--     donation that originated from a scanned letter can be reconciled
--     back to the printed QR (and through it, the campaign + optionally
--     the named recipient). The existing `campaign_id` column stays the
--     authoritative campaign attribution; `qr_code_id` provides the
--     channel/source breakdown the admin needs to answer
--     "how many gifts came from postal scans?" (Epic #274 comment 2).

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE postal_export_mode AS ENUM ('door_drop', 'personalized');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE postal_export_status AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── campaign_constituents ──────────────────────────────────────────────────

CREATE TABLE campaign_constituents (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id     UUID         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  constituent_id  UUID         NOT NULL REFERENCES constituents(id) ON DELETE CASCADE,
  -- Audit who added the link. NULL for system / migration adds; SET NULL on
  -- user-row purge to avoid orphan FK errors during GDPR erasure of a staff
  -- account.
  added_by        UUID         REFERENCES users(id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX campaign_constituents_org_idx
  ON campaign_constituents (org_id);
CREATE INDEX campaign_constituents_campaign_idx
  ON campaign_constituents (campaign_id);
CREATE INDEX campaign_constituents_constituent_idx
  ON campaign_constituents (constituent_id);
-- Unique (campaign, constituent) per tenant — re-adding the same row from the
-- UI is a no-op, not a duplicate. ON CONFLICT DO NOTHING in the service rides
-- this constraint.
CREATE UNIQUE INDEX campaign_constituents_org_campaign_constituent_uniq
  ON campaign_constituents (org_id, campaign_id, constituent_id);

ALTER TABLE campaign_constituents ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_constituents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_constituents
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_constituents TO givernance_app;

-- ─── campaign_postal_exports ────────────────────────────────────────────────

CREATE TABLE campaign_postal_exports (
  id                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id       UUID                  NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mode              postal_export_mode    NOT NULL,
  status            postal_export_status  NOT NULL DEFAULT 'pending',
  -- Total expected PDFs (= constituent count for personalized, 1 for door-drop).
  -- Locked at job-start so the progress bar denominator stays stable even if
  -- the campaign membership is mutated mid-job.
  total_count       INTEGER               NOT NULL DEFAULT 0,
  progress_count    INTEGER               NOT NULL DEFAULT 0,
  -- ZIP S3 key (in the campaigns bucket). NULL until the worker finishes.
  zip_s3_path       VARCHAR(500),
  -- Captured error message on terminal failure. Surfaced to the admin UI as
  -- a generic toast; the structured worker logs carry the stack.
  error             TEXT,
  requested_by      UUID                  REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX campaign_postal_exports_org_idx
  ON campaign_postal_exports (org_id);
CREATE INDEX campaign_postal_exports_campaign_idx
  ON campaign_postal_exports (campaign_id);
CREATE INDEX campaign_postal_exports_created_at_idx
  ON campaign_postal_exports (created_at DESC);

ALTER TABLE campaign_postal_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_postal_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_postal_exports
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_postal_exports TO givernance_app;

-- ─── donations.qr_code_id ───────────────────────────────────────────────────

ALTER TABLE donations
  ADD COLUMN qr_code_id UUID REFERENCES campaign_qr_codes(id) ON DELETE SET NULL;

CREATE INDEX donations_qr_code_id_idx ON donations (qr_code_id);
