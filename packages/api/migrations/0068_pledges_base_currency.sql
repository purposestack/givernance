-- Migration: 0068_pledges_base_currency (Epic #434, issue #435)
--
-- Adds `pledges.amount_base_cents` + `pledges.exchange_rate` so the
-- Revenu récurrent (MRR) KPI on the super-admin dashboard sums
-- comparable values across multi-currency tenants. Mirrors the
-- (amount_cents, currency, exchange_rate, amount_base_cents) quartet
-- on `donations` (migration 0023_multi_currency_schema) — same
-- semantics, same back-fill story.
--
-- Backfill semantics:
--   1. Add `amount_base_cents` as NULLABLE first.
--   2. Add `exchange_rate` with `DEFAULT 1` so the column is
--      populated on every existing row in one statement (every legacy
--      pledge is treated as 1:1 against the org's base currency —
--      acceptable because >99% of pledges today are EUR-on-EUR; the
--      tiny multi-currency tail re-snapshots its rate the next time
--      the worker emits `pledge.updated`).
--   3. Backfill `amount_base_cents = ROUND(amount_cents * 1)` for
--      existing rows.
--   4. Promote `amount_base_cents` to NOT NULL.
--
-- The Stripe pledge-creation code path (touched in SUB-WORKER #436)
-- will snapshot the live FX rate at pledge creation and on
-- `pledge.updated`. The MRR KPI sums
-- `SUM(amount_base_cents normalised to monthly) WHERE status='active'`
-- so a pledge whose underlying transactional amount stays in CHF still
-- contributes the right EUR-equivalent figure to the platform-wide MRR.

ALTER TABLE pledges
  ADD COLUMN amount_base_cents INTEGER,
  ADD COLUMN exchange_rate NUMERIC(18, 8) NOT NULL DEFAULT 1;

UPDATE pledges
SET amount_base_cents = ROUND(amount_cents * exchange_rate)::INTEGER
WHERE amount_base_cents IS NULL;

ALTER TABLE pledges
  ALTER COLUMN amount_base_cents SET NOT NULL;
