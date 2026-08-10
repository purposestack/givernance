-- Migration 0058: Add bank_account_id FK to funds (ADR-032 §2.4, Epic #416 Task 3)
--
-- Adds the settlement account binding to funds. Nullable initially — existing
-- funds have no bank account assigned. A follow-up migration will enforce NOT
-- NULL once all funds are assigned.

ALTER TABLE funds
  ADD COLUMN bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE RESTRICT;

CREATE INDEX funds_bank_account_id_idx ON funds (bank_account_id)
  WHERE bank_account_id IS NOT NULL;
