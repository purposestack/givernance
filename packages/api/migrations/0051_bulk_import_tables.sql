-- Bulk Import Tables Migration
-- Epic: #373 - Bulk Import Constituents Phase 1

-- 1. Create Enum
CREATE TYPE bulk_import_job_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'partial',
  'failed'
);

-- 2. Create bulk_import_files table
CREATE TABLE bulk_import_files (
  id                          UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- S3/MinIO storage reference
  s3_key                      VARCHAR(500)          NOT NULL,
  s3_bucket                   VARCHAR(100)          NOT NULL,
  file_name                   VARCHAR(255)          NOT NULL,
  file_size                   INTEGER               NOT NULL,
  mime_type                   VARCHAR(100)          NOT NULL,
  
  -- Template version used (for future compatibility)
  template_version            VARCHAR(20)           NOT NULL DEFAULT '1.0',
  
  -- Timestamps
  deleted_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

CREATE INDEX bulk_import_files_org_idx ON bulk_import_files (org_id);
CREATE INDEX bulk_import_files_created_at_idx ON bulk_import_files (created_at DESC);

ALTER TABLE bulk_import_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_files FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bulk_import_files
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_import_files TO givernance_app;

-- 3. Create bulk_import_jobs table
CREATE TABLE bulk_import_jobs (
  id                          UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Job status and metadata
  status                      bulk_import_job_status NOT NULL DEFAULT 'pending',
  total_rows                  INTEGER               NOT NULL DEFAULT 0,
  processed_rows              INTEGER               NOT NULL DEFAULT 0,
  created_count               INTEGER               NOT NULL DEFAULT 0,
  duplicate_count             INTEGER               NOT NULL DEFAULT 0,
  failed_count                INTEGER               NOT NULL DEFAULT 0,
  complete_address_count      INTEGER               NOT NULL DEFAULT 0,
  email_count                 INTEGER               NOT NULL DEFAULT 0,
  
  -- File reference
  file_id                     UUID                  NOT NULL REFERENCES bulk_import_files(id) ON DELETE CASCADE,
  
  -- Requesting user (for audit)
  requested_by                UUID                  REFERENCES users(id) ON DELETE SET NULL,
  
  -- Error details
  error                       TEXT,
  
  -- Timestamps
  deleted_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  
  -- Defense-in-depth: ensure counts match progress
  CONSTRAINT bulk_import_jobs_progress_chk CHECK (
    processed_rows <= total_rows
    AND created_count + duplicate_count + failed_count <= processed_rows
  )
);

CREATE INDEX bulk_import_jobs_org_idx ON bulk_import_jobs (org_id);
CREATE INDEX bulk_import_jobs_created_at_idx ON bulk_import_jobs (created_at DESC);
CREATE INDEX bulk_import_jobs_status_idx ON bulk_import_jobs (status);

ALTER TABLE bulk_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bulk_import_jobs
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_import_jobs TO givernance_app;

-- 4. Create bulk_import_results table
CREATE TABLE bulk_import_results (
  id                          UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id                      UUID                  NOT NULL REFERENCES bulk_import_jobs(id) ON DELETE CASCADE,
  
  -- Row info from the uploaded file
  row_number                  INTEGER               NOT NULL,
  row_data                    JSONB                 NOT NULL,
  
  -- Result status
  status                      VARCHAR(20)           NOT NULL CHECK (status IN ('created', 'duplicate', 'failed')),
  
  -- For created constituents
  constituent_id              UUID                  REFERENCES constituents(id) ON DELETE SET NULL,
  
  -- For duplicates
  duplicate_of_id             UUID                  REFERENCES constituents(id) ON DELETE SET NULL,
  duplicate_score             NUMERIC(3,2),
  
  -- For failures
  error_code                  VARCHAR(50),
  error_message               TEXT,
  
  created_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

CREATE INDEX bulk_import_results_job_idx ON bulk_import_results (job_id);
CREATE INDEX bulk_import_results_org_idx ON bulk_import_results (org_id);
CREATE INDEX bulk_import_results_status_idx ON bulk_import_results (status);

ALTER TABLE bulk_import_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_results FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bulk_import_results
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT ON bulk_import_results TO givernance_app;
