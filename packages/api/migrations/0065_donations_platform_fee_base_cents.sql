-- Migration: 0065_donations_platform_fee_base_cents (Epic #434, issue #435)
--
-- Adds `donations.platform_fee_base_cents` — the platform fee normalised to
-- the org's base currency (`tenants.base_currency`). Today
-- `platform_fee_cents` is stored in the donation's transactional currency
-- (USD donation → USD fee), which makes the super-admin "Revenu
-- Givernance" KPI silently wrong for multi-currency tenants: summing
-- mixed-currency cents into a single number is meaningless. Mirrors the
-- existing `amount_cents` / `amount_base_cents` pair on the same table
-- (added by migration 0023_multi_currency_schema).
--
-- Backfill semantics:
--   * Rows where `platform_fee_cents = 0` keep `platform_fee_base_cents
--     = 0` (DEFAULT). Nothing to convert.
--   * Rows where `platform_fee_cents > 0` are backfilled as
--     ROUND(platform_fee_cents * COALESCE(exchange_rate, 1)). The
--     `COALESCE` covers legacy rows where `exchange_rate` was nullable
--     before 0023 (the column is now NOT NULL on new writes but old
--     rows can still carry NULL).
--   * The forward-going Stripe webhook handler + the donation-creation
--     code path will populate this column at write time (touched in
--     SUB-WORKER #436).
--
-- No index — every dashboard query SUMs across the whole tenant in a
-- date window; the existing `donations_org_id_idx` +
-- `donations_donated_at_idx` already cover the access pattern.

ALTER TABLE donations
  ADD COLUMN platform_fee_base_cents INTEGER NOT NULL DEFAULT 0;

UPDATE donations
SET platform_fee_base_cents = ROUND(platform_fee_cents * COALESCE(exchange_rate, 1))::INTEGER
WHERE platform_fee_cents > 0;
