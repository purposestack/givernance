-- 0045 — Allocation percentage snapshot (issue #230).
--
-- Adds an optional percentage_bp column (basis points, 1-10000 where
-- 10000 = 100%) to donation_allocations. NULL = allocation was entered in
-- absolute amount mode. When set, the stored amount_cents is derived from
-- the donation total at creation time:
--   amount_cents = ROUND(donation.amount_cents * percentage_bp / 10000)
--
-- The existing check_allocation_sum trigger still applies — only
-- amount_cents is invariant. percentage_bp is a snapshot annotation.
--
-- Idempotent — safe to re-run.

ALTER TABLE donation_allocations
  ADD COLUMN IF NOT EXISTS percentage_bp INTEGER
    CHECK (percentage_bp > 0 AND percentage_bp <= 10000);
