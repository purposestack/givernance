-- Migration: 0038_allocation_enrichment
-- Extends donation_allocations to support:
--   1. amount_base_cents — pre-converted amount in the tenant's pivot currency
--   2. percentage_bp     — basis-points split (10000 bp = 100%) for proportional allocations
--   3. amount_cents nullable — supports percentage-mode rows (no fixed amount)
--   4. XOR constraint — every row is either fixed-amount OR percentage, never both
--   5. Trigger rewrite — check_allocation_sum enforces mode A (sum = donation) or
--                         mode B (sum = 10000 bp), and rejects mixed-mode allocations

-- ─── amount_base_cents ────────────────────────────────────────────────────────
ALTER TABLE donation_allocations
  ADD COLUMN IF NOT EXISTS amount_base_cents INTEGER;

-- ─── percentage_bp ────────────────────────────────────────────────────────────
ALTER TABLE donation_allocations
  ADD COLUMN IF NOT EXISTS percentage_bp INTEGER
  CONSTRAINT donation_allocations_percentage_bp_range CHECK (percentage_bp BETWEEN 1 AND 10000);

-- ─── amount_cents nullable (percentage-mode rows have no fixed amount) ────────
ALTER TABLE donation_allocations
  ALTER COLUMN amount_cents DROP NOT NULL;

-- ─── XOR: exactly one of amount_cents / percentage_bp must be set ─────────────
--> statement-breakpoint
ALTER TABLE donation_allocations
  ADD CONSTRAINT donation_allocations_amount_or_bp CHECK (
    (amount_cents IS NOT NULL AND percentage_bp IS NULL) OR
    (amount_cents IS NULL     AND percentage_bp IS NOT NULL)
  );

-- ─── Trigger rewrite ─────────────────────────────────────────────────────────
-- Mode A: all rows have amount_cents, sum must equal donations.amount_cents
-- Mode B: all rows have percentage_bp, sum must equal 10000 (100 %)
-- Mixed-mode (rows with both types within the same donation) is rejected.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_allocation_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_donation_id   UUID;
  v_amount_sum    INTEGER;
  v_bp_sum        INTEGER;
  v_donation_amt  INTEGER;
  v_amount_count  INTEGER;
  v_bp_count      INTEGER;
  v_total_rows    INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_donation_id := OLD.donation_id;
  ELSE
    v_donation_id := NEW.donation_id;
  END IF;

  SELECT
    COUNT(*)                            INTO v_total_rows,
    COUNT(amount_cents)                 INTO v_amount_count,
    COUNT(percentage_bp)                INTO v_bp_count,
    COALESCE(SUM(amount_cents), 0)      INTO v_amount_sum,
    COALESCE(SUM(percentage_bp), 0)     INTO v_bp_sum
  FROM donation_allocations
  WHERE donation_id = v_donation_id;

  -- Zero rows = no allocations, always valid
  IF v_total_rows = 0 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Reject mixed-mode within the same donation
  IF v_amount_count > 0 AND v_bp_count > 0 THEN
    RAISE EXCEPTION 'Mixed allocation modes (amount_cents and percentage_bp) on donation %',
      v_donation_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_amount_count = v_total_rows THEN
    -- Mode A: sum of amounts must equal donation.amount_cents
    SELECT amount_cents INTO v_donation_amt FROM donations WHERE id = v_donation_id;
    IF v_amount_sum <> v_donation_amt THEN
      RAISE EXCEPTION 'Allocation sum (%) does not equal donation amount (%) for donation %',
        v_amount_sum, v_donation_amt, v_donation_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- Mode B: sum of basis points must equal 10000 (100 %)
    IF v_bp_sum <> 10000 THEN
      RAISE EXCEPTION 'Percentage allocation sum (% bp) must equal 10000 bp for donation %',
        v_bp_sum, v_donation_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
