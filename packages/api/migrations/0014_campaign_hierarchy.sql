-- 0014_campaign_hierarchy.sql
-- Add campaign hierarchy (parent_id) and cost tracking (cost_cents) columns

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cost_cents INTEGER;

CREATE INDEX IF NOT EXISTS campaigns_parent_id_idx ON campaigns(parent_id);

-- Prevent a campaign from being its own parent
ALTER TABLE campaigns ADD CONSTRAINT campaigns_no_self_parent CHECK (parent_id <> id);
