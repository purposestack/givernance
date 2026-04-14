-- Migration: 0010_postal_campaigns
-- Creates campaigns, campaign_documents, and campaign_qr_codes tables
-- with RLS tenant isolation policies.

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE campaign_type AS ENUM ('nominative_postal', 'door_drop', 'digital');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM ('draft', 'active', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_document_status AS ENUM ('pending', 'generated', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Campaigns ──────────────────────────────────────────────────────────────

CREATE TABLE campaigns (
  id          UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(255)      NOT NULL,
  type        campaign_type     NOT NULL,
  status      campaign_status   NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX campaigns_org_id_idx ON campaigns (org_id);

-- ─── Campaign Documents ─────────────────────────────────────────────────────

CREATE TABLE campaign_documents (
  id              UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID                      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id     UUID                      NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  constituent_id  UUID                      REFERENCES constituents(id) ON DELETE SET NULL,
  s3_path         VARCHAR(500)              NOT NULL,
  status          campaign_document_status  NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ               NOT NULL DEFAULT NOW()
);

CREATE INDEX campaign_documents_org_id_idx ON campaign_documents (org_id);
CREATE INDEX campaign_documents_campaign_id_idx ON campaign_documents (campaign_id);

-- ─── Campaign QR Codes ──────────────────────────────────────────────────────

CREATE TABLE campaign_qr_codes (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id     UUID          NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  constituent_id  UUID          REFERENCES constituents(id) ON DELETE SET NULL,
  code            VARCHAR(255)  NOT NULL UNIQUE,
  scanned_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX campaign_qr_codes_org_id_idx ON campaign_qr_codes (org_id);
CREATE INDEX campaign_qr_codes_campaign_id_idx ON campaign_qr_codes (campaign_id);

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

ALTER TABLE campaign_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_documents
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

ALTER TABLE campaign_qr_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_qr_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_qr_codes
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Grant permissions to app role ─────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_documents TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_qr_codes TO givernance_app;
