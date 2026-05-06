-- 0044 — Donation exchange-rate snapshot (issue #230).
--
-- Three columns formalise the "rate snapshot" contract:
--   exchange_rate_at        — ISO date of the rate used (always today at donation time).
--                             Lets us replay / audit the exact rate row that was applied.
--   base_currency_at_donation — tenant base currency captured at the moment of donation.
--                             Immunises history against future tenant currency changes.
--   exchange_rate_source    — how the rate was obtained: same_currency | local_exact |
--                             api_cache | api | local_fallback | default_fallback.
--                             Surfaces data-quality risk at read time.
--
-- Idempotent — safe to re-run.

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS exchange_rate_at DATE,
  ADD COLUMN IF NOT EXISTS base_currency_at_donation VARCHAR(3),
  ADD COLUMN IF NOT EXISTS exchange_rate_source VARCHAR(32);

-- Back-fill existing rows: exchange_rate_at = donated_at::date, source = 'unknown'.
-- base_currency_at_donation stays NULL for historical rows (no way to recover it).
UPDATE donations
   SET exchange_rate_at = donated_at::date,
       exchange_rate_source = 'unknown'
 WHERE exchange_rate_at IS NULL;
