-- Migration: 0067_donations_refunded_at (Epic #434, issue #435)
--
-- Adds `donations.refunded_at` so the refund-rate KPI on the super-
-- admin dashboard can be scoped by refund DATE rather than the
-- donation's original creation date. Without this, a refund issued in
-- May 2026 against a donation made in January 2026 would land in the
-- January bucket — meaningless for an operations health signal that
-- watches "are we refunding more than usual THIS PERIOD?".
--
-- Distinct from `updated_at` (which moves on every row touch — receipt
-- regeneration, fund reallocation, etc.) and from `status='refunded'`
-- (which only tells us THAT a row is refunded, not WHEN).
--
-- Populated by the Stripe `charge.refunded` webhook handler (already
-- exists today, will be amended in SUB-WORKER #436 to also stamp this
-- column). For historical rows where `status='refunded'` is already
-- set, this column stays NULL — we don't have a reliable refund
-- timestamp for those (the original webhook only updated `status`).
-- The dashboard treats NULL `refunded_at` as "refund predates the
-- timestamp column" and excludes such rows from the per-period
-- refund-rate denominator (a sensible default for the small backlog of
-- pre-migration refunds).
--
-- Index supports the per-period scoping query: `WHERE status='refunded'
-- AND refunded_at BETWEEN ? AND ?`. Filtered to non-NULL so the index
-- doesn't grow with every fresh donation row.

ALTER TABLE donations
  ADD COLUMN refunded_at TIMESTAMPTZ;

CREATE INDEX donations_refunded_at_idx
  ON donations (refunded_at)
  WHERE refunded_at IS NOT NULL;
