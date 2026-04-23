-- Migration: 0025_campaign_funds
-- Adds tenant-scoped campaign_funds linkage with cascading cleanup and RLS.

CREATE TABLE campaign_funds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  fund_id     UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_funds_org_campaign_fund_uniq UNIQUE (org_id, campaign_id, fund_id)
);

CREATE INDEX campaign_funds_org_id_idx ON campaign_funds (org_id);
CREATE INDEX campaign_funds_campaign_id_idx ON campaign_funds (campaign_id);
CREATE INDEX campaign_funds_fund_id_idx ON campaign_funds (fund_id);

ALTER TABLE campaign_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_funds FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_funds
  USING (org_id = app_current_organization_id())
  WITH CHECK (org_id = app_current_organization_id());
