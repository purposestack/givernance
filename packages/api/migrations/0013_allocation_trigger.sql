-- Migration: 0013_allocation_trigger
-- Adds a database trigger that enforces the invariant: the sum of
-- donation_allocations.amount_cents must equal donations.amount_cents
-- whenever allocations are inserted, updated, or deleted.

CREATE OR REPLACE FUNCTION check_allocation_sum()
RETURNS TRIGGER AS $$
DECLARE
  alloc_sum   INTEGER;
  donation_amt INTEGER;
BEGIN
  -- Determine which donation_id to check
  -- On DELETE, use OLD; on INSERT/UPDATE, use NEW
  IF TG_OP = 'DELETE' THEN
    SELECT COALESCE(SUM(amount_cents), 0) INTO alloc_sum
      FROM donation_allocations
     WHERE donation_id = OLD.donation_id;

    SELECT amount_cents INTO donation_amt
      FROM donations
     WHERE id = OLD.donation_id;
  ELSE
    SELECT COALESCE(SUM(amount_cents), 0) INTO alloc_sum
      FROM donation_allocations
     WHERE donation_id = NEW.donation_id;

    SELECT amount_cents INTO donation_amt
      FROM donations
     WHERE id = NEW.donation_id;
  END IF;

  -- Only enforce when allocations exist (zero allocations is valid — no split)
  IF alloc_sum > 0 AND alloc_sum <> donation_amt THEN
    RAISE EXCEPTION 'Allocation sum (%) does not equal donation amount (%)',
      alloc_sum, donation_amt
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_allocation_sum
  AFTER INSERT OR UPDATE OR DELETE ON donation_allocations
  FOR EACH ROW
  EXECUTE FUNCTION check_allocation_sum();
