-- Migration 0060: Add FX accounting columns to donations (ADR-031 §2.3, Epic #416 Task 5)
--
-- Extends donations with:
--   fee breakdown  (transaction_fee_cents, forex_fee_cents, net_amount_cents)
--   settlement     (settled_amount_cents, settled_currency, stripe_balance_txn_id)
--   FX provenance  (exchange_rate_source, exchange_rate_timestamp, amount_in_settlement_currency_cents)
--   resilience     (fx_pending)
--
-- All new columns are nullable / have defaults — existing rows keep NULL where appropriate.

-- Fee breakdown
ALTER TABLE donations
  ADD COLUMN transaction_fee_cents   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN forex_fee_cents         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN net_amount_cents        INTEGER;

-- Settlement record
ALTER TABLE donations
  ADD COLUMN settled_amount_cents    INTEGER,
  ADD COLUMN settled_currency        VARCHAR(3),
  ADD COLUMN stripe_balance_txn_id   TEXT;

-- FX accounting
ALTER TABLE donations
  ADD COLUMN exchange_rate_source        TEXT,
  ADD COLUMN exchange_rate_timestamp     TIMESTAMPTZ,
  ADD COLUMN amount_in_settlement_currency_cents INTEGER;

-- Outage resilience
ALTER TABLE donations
  ADD COLUMN fx_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- CHECK constraint: valid exchange_rate_source values
ALTER TABLE donations
  ADD CONSTRAINT donations_exchange_rate_source_check
    CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN (
      'stripe_balance_txn', 'fixer_api', 'backfilled', 'manual', 'same_currency'
    ));

-- Index for the backfill job query
CREATE INDEX donations_fx_pending_idx ON donations (org_id, created_at)
  WHERE fx_pending = TRUE;
