-- 0023_multi_currency_schema.sql
-- Adds the foundational multi-currency schema:
-- - historical exchange rates
-- - tenant and campaign default/base currencies
-- - donation exchange-rate and base-amount tracking

CREATE TABLE IF NOT EXISTS exchange_rates (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  currency       VARCHAR(3)     NOT NULL,
  base_currency  VARCHAR(3)     NOT NULL,
  rate           NUMERIC(18, 8) NOT NULL,
  date           DATE           NOT NULL,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT exchange_rates_currency_base_date_uniq
    UNIQUE (currency, base_currency, date)
);

CREATE INDEX IF NOT EXISTS exchange_rates_currency_idx ON exchange_rates (currency);
CREATE INDEX IF NOT EXISTS exchange_rates_base_currency_idx ON exchange_rates (base_currency);
CREATE INDEX IF NOT EXISTS exchange_rates_date_idx ON exchange_rates (date);

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS base_currency VARCHAR(3) NOT NULL DEFAULT 'EUR';

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS default_currency VARCHAR(3) NOT NULL DEFAULT 'EUR';

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS amount_base_cents INTEGER;

UPDATE donations
SET amount_base_cents = amount_cents
WHERE amount_base_cents IS NULL;

UPDATE donations
SET exchange_rate = 1
WHERE exchange_rate IS NULL
  AND currency = 'EUR';

ALTER TABLE donations
  ALTER COLUMN amount_base_cents SET NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON exchange_rates TO givernance_app;
