-- Migration: 0016_public_pages
-- Adds campaign_public_pages table for embeddable public donation pages.

-- ─── Public Page Status Enum ──────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public_page_status AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Campaign Public Pages ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_public_pages (
  id                UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID               NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id       UUID               NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE UNIQUE,
  status            public_page_status NOT NULL DEFAULT 'draft',
  title             VARCHAR(255)       NOT NULL,
  description       TEXT,
  color_primary     VARCHAR(7),
  goal_amount_cents INTEGER,
  created_at        TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_public_pages_org_id_idx ON campaign_public_pages (org_id);
CREATE INDEX IF NOT EXISTS campaign_public_pages_campaign_id_idx ON campaign_public_pages (campaign_id);

-- ─── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE campaign_public_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_public_pages FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_public_pages
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Grant permissions to app role ────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_public_pages TO givernance_app;
