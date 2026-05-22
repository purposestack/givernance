-- Migration: 0057_currency_metadata (ADR-031 §2.9, Epic #416, Task 2)
--
-- Platform-managed currency reference table. One row per ISO 4217 currency
-- code. Carries Stripe-specific metadata (zero-decimal flag, special-handling
-- flag, minimum chargeable amount) so the checkout-config service can validate
-- amounts without a hard-coded switch in application code.
--
-- Design notes (full rationale in `docs/adrs/adr-031-multi-currency.md`):
--
--   * No `org_id` — this is a platform table, not a tenant-scoped one.
--     The app role (`givernance_app`) gets SELECT-only access; writes are
--     migration-only. No RLS needed (no PII, no tenant isolation concern).
--
--   * `code` is the PK (VARCHAR 3). Natural key, globally unique, compact
--     join key for `donations.currency`, `bank_accounts.currency`, etc.
--
--   * `minor_unit` is SMALLINT (ISO 4217 exponent). 0 = zero-decimal (JPY),
--     2 = two-decimal (EUR, CHF, GBP), 3 = three-decimal (KWD — deferred).
--
--   * `stripe_zero_dec` differs from `minor_unit = 0` — Stripe's zero-decimal
--     list is NOT the ISO 4217 list. Always use this column for Stripe calls.
--
--   * `stripe_special` is true when Stripe imposes a non-standard minimum or
--     rounding rule (e.g. HUF must be a multiple of 100). The checkout-config
--     service checks this flag and returns a 422 with a hint before sending.
--
--   * `stripe_min_amt` is the minimum chargeable amount in the currency's
--     smallest unit (as documented by Stripe). The validator compares
--     `amount_cents >= stripe_min_amt` before forwarding to Stripe.
--
--   * `enabled = false` by default. The seed below enables the initial set of
--     currencies Givernance actively supports. New currencies are added via a
--     follow-up migration; the `enabled` flag is the operator switch, not a
--     code change.
--
-- Idempotent — `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` per the
-- `feedback_never_modify_applied_migrations` rule.

-- ─── currency_metadata table ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS currency_metadata (
  -- ISO 4217 alpha-3 code, e.g. "EUR", "CHF". Natural PK.
  code             VARCHAR(3)  PRIMARY KEY,
  -- Human-readable English name, e.g. "Euro", "Swiss Franc".
  name             TEXT        NOT NULL,
  -- ISO 4217 exponent: number of decimal places (0, 2, or 3).
  minor_unit       SMALLINT    NOT NULL,
  -- True when Stripe treats this currency as zero-decimal (amount is
  -- already in the smallest unit). Stripe's list ≠ ISO 4217 minor_unit = 0.
  stripe_zero_dec  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- True when Stripe imposes a non-standard minimum or rounding rule.
  stripe_special   BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Minimum chargeable amount in the currency's smallest unit (Stripe docs).
  stripe_min_amt   INTEGER     NOT NULL,
  -- Platform on/off switch. Only enabled currencies are offered to tenants.
  enabled          BOOLEAN     NOT NULL DEFAULT FALSE
);

GRANT SELECT ON currency_metadata TO givernance_app;

-- ─── Seed: initial enabled currency set ──────────────────────────────────────
--
-- Currencies enabled by default are those Givernance actively supports in
-- Phase 1 for European NPOs (EUR, CHF, GBP, SEK, NOK, DKK, PLN, CZK).
--
-- JPY and HUF are seeded but disabled:
--   - JPY: zero-decimal Stripe currency; enabled=false until the donation form
--     handles the zero-decimal UX (no decimal input, amounts like ¥500).
--   - HUF: stripe_special=true; requires amounts in multiples of 100 forint.
--     Enabled=false until the validator enforces the rounding rule.
--
-- stripe_min_amt values sourced from Stripe's minimum charge amounts doc
-- (https://stripe.com/docs/currencies#minimum-and-maximum-charge-amounts):
--   EUR/CHF/USD: 50 (€0.50), GBP: 30 (£0.30), SEK/NOK: 300 (3 kr),
--   DKK: 250 (2.50 kr), PLN: 200 (2 zł), CZK: 1500 (15 Kč),
--   JPY: 50 (¥50, zero-decimal so 50 = ¥50), HUF: 17500 (175 Ft).

INSERT INTO currency_metadata (code, name, minor_unit, stripe_zero_dec, stripe_special, stripe_min_amt, enabled)
VALUES
  ('EUR', 'Euro',             2, FALSE, FALSE,    50, TRUE),
  ('CHF', 'Swiss Franc',      2, FALSE, FALSE,    50, TRUE),
  ('GBP', 'British Pound',    2, FALSE, FALSE,    30, TRUE),
  ('USD', 'US Dollar',        2, FALSE, FALSE,    50, TRUE),
  ('SEK', 'Swedish Krona',    2, FALSE, FALSE,   300, TRUE),
  ('NOK', 'Norwegian Krone',  2, FALSE, FALSE,   300, TRUE),
  ('DKK', 'Danish Krone',     2, FALSE, FALSE,   250, TRUE),
  ('PLN', 'Polish Zloty',     2, FALSE, FALSE,   200, TRUE),
  ('CZK', 'Czech Koruna',     2, FALSE, FALSE,  1500, TRUE),
  ('JPY', 'Japanese Yen',     0, TRUE,  FALSE,    50, FALSE),
  ('HUF', 'Hungarian Forint', 2, FALSE, TRUE,  17500, FALSE)
ON CONFLICT (code) DO NOTHING;
