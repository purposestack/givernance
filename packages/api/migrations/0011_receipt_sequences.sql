-- Migration: 0011_receipt_sequences
-- Adds gapless receipt numbering sequence table and unique constraint on receipts.
-- Fixes the count(*)+1 race condition in receipt number generation.

-- 1. Create the receipt_sequences table for atomic counter increments
CREATE TABLE IF NOT EXISTS receipt_sequences (
  org_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fiscal_year  INTEGER NOT NULL,
  next_val     INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT receipt_sequences_pkey UNIQUE (org_id, fiscal_year)
);

-- Grant access to the app role
GRANT SELECT, INSERT, UPDATE ON receipt_sequences TO givernance_app;

-- 2. Add unique constraint on receipts to enforce fiscal correctness
ALTER TABLE receipts
  ADD CONSTRAINT receipts_org_fiscal_number_uniq
  UNIQUE (org_id, fiscal_year, receipt_number);
