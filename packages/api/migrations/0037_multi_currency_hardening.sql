-- Migration: 0037_multi_currency_hardening
-- Phase P0: Critical data integrity for the multi-currency subsystem.
-- Addresses:
--   1. exchange_rates missing source column — can't distinguish ECB / API / manual rates.
--   2. exchange_rates missing rate > 0 CHECK — a zero/negative rate would silently corrupt amountBaseCents.
--   3. exchange_rates missing composite index (currency, base_currency, date DESC) — needed
--      by getRate() ORDER BY date DESC LIMIT 1.
--   4. donations missing exchange_rate_at — can't replay/audit which DB row was used to convert.
--   5. donations missing base_currency_at_donation — if a tenant changes baseCurrency, historical
--      amountBaseCents silently refers to a different pivot currency.
--   6. donations missing exchange_rate_source — can't distinguish api / local_fallback / parity / etc.
--   7. donations.exchange_rate nullable — inconsistent with amount_base_cents NOT NULL; a donation
--      can have a converted amount without the rate that produced it.

-- ─── Step 1: exchange_rates — add source column ───────────────────────────

ALTER TABLE exchange_rates
  ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'unknown';

--> statement-breakpoint

-- ─── Step 2: exchange_rates — add rate > 0 CHECK ─────────────────────────
-- Preflight: abort if any existing row has rate <= 0 so the migration
-- fails loudly rather than silently allowing bad data through the constraint.

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM exchange_rates
   WHERE rate <= 0;

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      '0037 preflight: % exchange_rates rows have rate <= 0. Fix data before applying migration.',
      bad_count;
  END IF;
END
$$;

--> statement-breakpoint

ALTER TABLE exchange_rates
  ADD CONSTRAINT exchange_rates_rate_positive CHECK (rate > 0);

--> statement-breakpoint

-- ─── Step 3: exchange_rates — composite index for getRate() queries ───────
-- ExchangeRateService.getRate() queries:
--   SELECT rate FROM exchange_rates
--   WHERE currency = $1 AND base_currency = $2
--   ORDER BY date DESC, updated_at DESC LIMIT 1
-- The existing single-column indexes scan the full (currency) or (base_currency)
-- partition; this composite index allows an index-only scan for the most-common
-- "latest rate for a pair" lookup.

CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (currency, base_currency, date DESC);

--> statement-breakpoint

-- ─── Step 4: donations — add exchange_rate_at ─────────────────────────────
-- Stores the calendar date used when the exchange rate was looked up.
-- DEFAULT CURRENT_DATE applied to existing rows. Pre-migration rows get the
-- migration run date as a sentinel (the exact lookup date was never stored).
-- A follow-up job can set:
--   UPDATE donations SET exchange_rate_at = donated_at::date
--   WHERE exchange_rate_at = '<migration-date>';

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS exchange_rate_at DATE NOT NULL DEFAULT CURRENT_DATE;

--> statement-breakpoint

-- ─── Step 5: donations — add base_currency_at_donation ───────────────────
-- Snapshot of the tenant's baseCurrency at donation time. Without this,
-- changing tenants.base_currency retroactively redefines what
-- amountBaseCents means — silent data corruption.
--
-- Backfill strategy: read current tenants.base_currency for each donation's
-- org. Accurate only if no tenant has changed base_currency since their
-- earliest donation; the NOTICE output must be reviewed post-migration.

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS base_currency_at_donation VARCHAR(3);

--> statement-breakpoint

DO $$
DECLARE
  backfilled_from_tenant INTEGER;
  fallback_to_eur        INTEGER;
BEGIN
  -- Primary backfill: read from current tenants.base_currency
  UPDATE donations d
    SET base_currency_at_donation = t.base_currency
    FROM tenants t
   WHERE d.org_id = t.id
     AND d.base_currency_at_donation IS NULL;
  GET DIAGNOSTICS backfilled_from_tenant = ROW_COUNT;

  -- Safety fallback: any donations whose tenant row is somehow missing → EUR
  UPDATE donations
    SET base_currency_at_donation = 'EUR'
   WHERE base_currency_at_donation IS NULL;
  GET DIAGNOSTICS fallback_to_eur = ROW_COUNT;

  RAISE NOTICE '0037: backfilled base_currency_at_donation — % from tenants, % fallback EUR',
    backfilled_from_tenant, fallback_to_eur;
END
$$;

--> statement-breakpoint

ALTER TABLE donations
  ALTER COLUMN base_currency_at_donation SET NOT NULL;

--> statement-breakpoint

-- ─── Step 6: donations — add exchange_rate_source ─────────────────────────
-- Records which fallback tier provided the rate:
--   same_currency   — donor currency == base currency; rate = 1 (no FX risk)
--   local_exact     — row from exchange_rates for exactly this date
--   api             — fresh fetch from exchangerate-api.com
--   api_cache       — in-process cache hit (same rate as 'api', different tier)
--   local_fallback  — most-recent DB row (date < today)
--   default_fallback — no rate available; rate was set to 1 (data quality risk)
--   unknown         — pre-migration rows; value unknown

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS exchange_rate_source VARCHAR(32) NOT NULL DEFAULT 'unknown';

--> statement-breakpoint

-- ─── Step 7: donations — make exchange_rate NOT NULL ─────────────────────
-- Patch any NULL rows before adding the constraint.
-- Same-currency donations get rate=1 (correct, no FX risk).
-- Foreign-currency donations with NULL rate get rate=1 sentinel — these
-- represent data quality issues that must be investigated post-migration.
-- The NOTICE warns operators if any foreign-currency NULLs exist.

DO $$
DECLARE
  parity_fixed  INTEGER;
  foreign_nulls INTEGER;
BEGIN
  SELECT COUNT(*) INTO foreign_nulls
    FROM donations
   WHERE exchange_rate IS NULL
     AND currency <> base_currency_at_donation;

  IF foreign_nulls > 0 THEN
    RAISE NOTICE
      '0037 WARNING: % foreign-currency donations have NULL exchange_rate; '
      'setting to 1.0 sentinel. Run: '
      'SELECT id, org_id, currency, base_currency_at_donation, donated_at '
      'FROM donations WHERE exchange_rate_source = ''unknown'' '
      'AND currency <> base_currency_at_donation; '
      'to identify rows that need manual correction.',
      foreign_nulls;
  END IF;

  -- Fix same-currency donations (definitively correct at 1.0)
  UPDATE donations
    SET exchange_rate = 1.0,
        exchange_rate_source = 'parity'
   WHERE exchange_rate IS NULL
     AND currency = base_currency_at_donation;
  GET DIAGNOSTICS parity_fixed = ROW_COUNT;

  -- Fix remaining NULLs (foreign-currency without a rate → sentinel)
  UPDATE donations
    SET exchange_rate = 1.0
   WHERE exchange_rate IS NULL;

  RAISE NOTICE '0037: set exchange_rate — % parity rows corrected (source=parity)', parity_fixed;
END
$$;

--> statement-breakpoint

ALTER TABLE donations
  ALTER COLUMN exchange_rate SET NOT NULL;
