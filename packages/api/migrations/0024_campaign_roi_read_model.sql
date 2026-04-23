-- 0024_campaign_roi_read_model.sql
-- Clarify campaign ROI semantics:
-- - cost_cents becomes operational_cost_cents
-- - campaigns gain platform_fees_cents
-- - donations gain status + platform_fee_cents so ROI can exclude pending/failed

DO $$ BEGIN
  CREATE TYPE donation_status AS ENUM ('pending', 'cleared', 'refunded', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS status donation_status NOT NULL DEFAULT 'cleared',
  ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_platform_fee_non_negative;
ALTER TABLE donations
  ADD CONSTRAINT donations_platform_fee_non_negative CHECK (platform_fee_cents >= 0);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'cost_cents'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'operational_cost_cents'
  ) THEN
    ALTER TABLE campaigns RENAME COLUMN cost_cents TO operational_cost_cents;
  END IF;
END $$;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS operational_cost_cents BIGINT,
  ADD COLUMN IF NOT EXISTS platform_fees_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_cost_non_negative;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_operational_cost_non_negative;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_platform_fees_non_negative;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_operational_cost_non_negative CHECK (operational_cost_cents >= 0),
  ADD CONSTRAINT campaigns_platform_fees_non_negative CHECK (platform_fees_cents >= 0);
