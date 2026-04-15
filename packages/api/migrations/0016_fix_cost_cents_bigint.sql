-- 0016_fix_cost_cents_bigint.sql
-- Ensure cost_cents is BIGINT (may have been created as INTEGER if column pre-existed migration 0014)

ALTER TABLE campaigns ALTER COLUMN cost_cents TYPE BIGINT;
