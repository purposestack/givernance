-- Migration: 0056_bank_accounts_multi_currency (Epic #416, Task 1)
--
-- Generalises the `bank_accounts` table from a Swiss-only QR-bill
-- account holder to a generic multi-currency settlement account per
-- ADR-032 §2.4:
--
--   1. Add `label` (VARCHAR 255, NOT NULL) — human-readable operator
--      label ("PostFinance CHF", "UBS EUR"). Required on all new rows;
--      existing rows get a generated label from `bank_name` + `currency`.
--
--   2. Add `is_active` (BOOLEAN, NOT NULL, DEFAULT TRUE) — soft-hide
--      without soft-delete; accounts with issued QR references cannot be
--      hard-deleted but can be deactivated so they no longer appear in
--      the campaign editor picker.
--
--   3. Change `currency` column from the `bank_account_currency` pgEnum
--      ("CHF" | "EUR") to VARCHAR(3) — open-ended ISO 4217 alpha-3 so
--      new currencies (GBP, SEK, NOK, …) can be added without a further
--      migration. Existing rows keep their CHF/EUR values unchanged.
--
--   4. Make `bank_name` nullable — some accounts (e.g. direct bank
--      feeds, API-provisioned) may not have a bank display name at
--      creation time.
--
--   5. Drop the now-unused `bank_account_currency` Postgres enum type.

-- ── 1. Add label (backfill from bank_name + currency before NOT NULL) ──

ALTER TABLE bank_accounts
  ADD COLUMN label VARCHAR(255);

-- Backfill: generate a label for existing rows so we can add NOT NULL.
UPDATE bank_accounts
  SET label = COALESCE(bank_name, '') || ' ' || currency
  WHERE label IS NULL;

ALTER TABLE bank_accounts
  ALTER COLUMN label SET NOT NULL;

-- ── 2. Add is_active ─────────────────────────────────────────────────

ALTER TABLE bank_accounts
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 3. Change currency from enum to varchar(3) ────────────────────────
--
-- Postgres does not allow changing a column from an enum to varchar
-- directly with ALTER COLUMN TYPE in the presence of a DEFAULT referencing
-- the enum. Steps:
--   a. Drop the column default (which references the enum).
--   b. Cast the column to varchar(3) using USING.
--   c. Leave the column without a default (operators must explicitly
--      specify the settlement currency — no implicit CHF default).

ALTER TABLE bank_accounts
  ALTER COLUMN currency DROP DEFAULT;

ALTER TABLE bank_accounts
  ALTER COLUMN currency TYPE VARCHAR(3)
  USING currency::TEXT;

-- ── 4. Make bank_name nullable ────────────────────────────────────────

ALTER TABLE bank_accounts
  ALTER COLUMN bank_name DROP NOT NULL;

-- ── 5. Drop the bank_account_currency enum ────────────────────────────
--
-- The enum is no longer referenced by any column after step 3.
-- Dropping it now keeps the catalog clean; it cannot be re-added by a
-- future migration without a conflict if this one is already applied.

DROP TYPE IF EXISTS bank_account_currency;

-- ── RLS: no policy changes needed ─────────────────────────────────────
--
-- All existing `bank_accounts` RLS policies key on `org_id` and are
-- unaffected by the column additions / type change. No new policies
-- are required.
