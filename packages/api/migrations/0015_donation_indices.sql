-- 0015_donation_indices.sql
-- Add composite index on donations for SYBUNT NOT EXISTS subquery optimization

CREATE INDEX IF NOT EXISTS donations_org_constituent_donated_idx
  ON donations(org_id, constituent_id, donated_at);
