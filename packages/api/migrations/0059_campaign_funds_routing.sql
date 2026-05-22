-- Migration 0059: Expand campaign_funds for multi-fund routing (ADR-031 §2.5, Epic #416 Task 4)

-- Add split routing columns
ALTER TABLE campaign_funds
  ADD COLUMN split_pct NUMERIC(5, 2),
  ADD COLUMN is_online_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN sort_order SMALLINT NOT NULL DEFAULT 0;

-- Add constraint: at most one is_online_default per campaign
CREATE UNIQUE INDEX campaign_funds_online_default_uniq
  ON campaign_funds (campaign_id)
  WHERE is_online_default = TRUE;
