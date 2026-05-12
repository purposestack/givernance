-- Migration: 0051_camt053_reconciliation (Epic #318 PR #5)
--
-- Schema additions to support camt.053 reconciliation (docs/25 §5.5,
-- ADR-028 §"Reopen criteria — bank-by-bank donor-data variance"):
--
--   * `constituents.data_source` — provenance discriminator
--     (`manual` | `csv_import` | `public_form` | `camt053`). Every
--     pre-existing row is back-filled to `manual` — the only honest
--     default for rows the reconciler never touched.
--
--   * `constituents.identity_completeness` — derived at write-time per
--     docs/25 §5.5:
--         `full`    = name + (email OR full postal address)
--         `partial` = name + IBAN, missing both email AND address
--         `minimal` = name only (TWINT-anonymised case)
--     The migration re-derives the value for every existing row from
--     the current data; the reconciler recomputes whenever it enriches
--     a row, never demoting back to a less-complete bucket.
--
--   * `constituents.payment_source_iban` — secondary match key for the
--     camt.053 enrichment branch (docs/25 §5.5 idempotency layer 3).
--     NULL on rows that never received a bank transfer; canonicalised
--     (uppercase alnum) on insert. A partial index on
--     `(org_id, payment_source_iban) WHERE payment_source_iban IS NOT NULL`
--     supports the reconciler's per-tenant lookup without bloating the
--     index with NULLs.
--
-- Idempotency: `ADD COLUMN IF NOT EXISTS` + DEFAULT, then back-fill in
-- a transactional UPDATE. Re-running the migration is a no-op (the
-- DEFAULT covers any rows that landed between the ADD and the UPDATE).

-- ─── constituents extensions ────────────────────────────────────────────────

ALTER TABLE constituents
  ADD COLUMN IF NOT EXISTS data_source VARCHAR(32) NOT NULL DEFAULT 'manual';

ALTER TABLE constituents
  ADD COLUMN IF NOT EXISTS identity_completeness VARCHAR(16) NOT NULL DEFAULT 'minimal';

ALTER TABLE constituents
  ADD COLUMN IF NOT EXISTS payment_source_iban VARCHAR(34);

-- Whitelist data_source values (typed enum would be heavier; the column
-- is a string for forward-compat with new rails — e.g. a future
-- `webhook` value when we add a third-party signup integration).
DO $$ BEGIN
  ALTER TABLE constituents ADD CONSTRAINT constituents_data_source_chk
    CHECK (data_source IN ('manual', 'csv_import', 'public_form', 'camt053'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE constituents ADD CONSTRAINT constituents_identity_completeness_chk
    CHECK (identity_completeness IN ('full', 'partial', 'minimal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Canonical (uppercase alnum, no whitespace) — same shape as
-- `bank_accounts.iban` so the join from camt_credit_entries.debtor_iban
-- doesn't need a normalisation step at query time.
DO $$ BEGIN
  ALTER TABLE constituents ADD CONSTRAINT constituents_payment_source_iban_canonical_chk
    CHECK (payment_source_iban IS NULL OR payment_source_iban ~ '^[A-Z0-9]+$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Back-fill identity_completeness for every existing row based on the
-- data already present. `full` if email OR (addressLine1 + postalCode +
-- city) is set; `partial` if some PII but not enough for re-mailing;
-- `minimal` is the safe default (name-only). Idempotent — re-running
-- after a reconciler enrichment is a no-op because the new value never
-- demotes a row.
UPDATE constituents
SET identity_completeness = CASE
  WHEN (email IS NOT NULL AND email <> '')
    OR (address_line1 IS NOT NULL AND address_line1 <> ''
        AND postal_code IS NOT NULL AND postal_code <> ''
        AND city IS NOT NULL AND city <> '')
  THEN 'full'
  WHEN (email IS NOT NULL AND email <> '')
    OR (address_line1 IS NOT NULL AND address_line1 <> '')
    OR (postal_code IS NOT NULL AND postal_code <> '')
    OR (city IS NOT NULL AND city <> '')
  THEN 'partial'
  ELSE 'minimal'
END
WHERE identity_completeness = 'minimal';

-- Partial index — supports the reconciler's enrichment lookup
-- (`SELECT … WHERE org_id=$1 AND payment_source_iban=$2`) without
-- bloating the index with NULL rows on the millions of donors who
-- never paid by bank transfer.
CREATE INDEX IF NOT EXISTS constituents_org_payment_iban_idx
  ON constituents (org_id, payment_source_iban)
  WHERE payment_source_iban IS NOT NULL;

-- ─── camt_credit_entries extensions ─────────────────────────────────────────
--
-- `reversal_indicator` — true on entries the bank tagged with
-- `Ntry.RvslInd=true`. The reconciler reads this to dispatch onto the
-- reversal branch (find the original donation by structured-ref +
-- mark refunded) instead of the normal "create a donation" path. Stored
-- on the credit-entry row rather than computed because the value is
-- bank-emitted (we want forensic provenance) and the donations table
-- already has `status='refunded'` so a separate reversal table would
-- duplicate state.
--
-- `debtor_address` — flattened `RltdPties.Dbtr.PstlAdr` JSONB. Used by
-- the reconciler's §5.5 extraction matrix (structured fields first,
-- AdrLine heuristic fallback). JSONB instead of a normalised set of
-- columns because (a) the data is bank-emitted PII we want to preserve
-- as-is for audit (CO Art. 958f), and (b) we only ever JOIN it once
-- (constituent enrichment); a per-field query path doesn't help.

ALTER TABLE camt_credit_entries
  ADD COLUMN IF NOT EXISTS reversal_indicator BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE camt_credit_entries
  ADD COLUMN IF NOT EXISTS debtor_address JSONB;

-- ─── camt_unreconciled_entries extensions ───────────────────────────────────
--
-- `linked_donation_id` — set when the operator resolves an unreconciled
-- row via `POST /v1/camt-unreconciled/:id/resolve { action: 'link' }`,
-- pointing at the donation row the operator manually created. ON DELETE
-- SET NULL preserves the audit trail of "operator linked this credit
-- to donation X on 2026-05-12" even if the donation is hard-deleted
-- later through the admin tool.

ALTER TABLE camt_unreconciled_entries
  ADD COLUMN IF NOT EXISTS linked_donation_id UUID
    REFERENCES donations(id) ON DELETE SET NULL;
