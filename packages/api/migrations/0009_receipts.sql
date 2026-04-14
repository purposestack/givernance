-- Migration: 0009_receipts
-- Creates the receipts table for storing generated tax receipt PDF metadata.

-- ─── Enum ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE receipt_status AS ENUM ('pending', 'generated', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Receipts ──────────────────────────────────────────────────────────────

CREATE TABLE receipts (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  donation_id     UUID            NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  receipt_number  VARCHAR(100)    NOT NULL,
  fiscal_year     INTEGER         NOT NULL,
  s3_path         VARCHAR(500)    NOT NULL,
  status          receipt_status  NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX receipts_org_id_idx ON receipts (org_id);
CREATE INDEX receipts_donation_id_idx ON receipts (donation_id);
CREATE UNIQUE INDEX receipts_org_fiscal_number_uniq ON receipts (org_id, fiscal_year, receipt_number);

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipts
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Grant permissions to app role ─────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON receipts TO givernance_app;
