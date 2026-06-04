-- Migration: 0052_camt053_reversal_partial_match (Epic #318 PR #5 hardening)
--
-- Two coupled changes the docs agent hardened in `docs/25` §5.2 + §5.4 step
-- 4.d (partial-match handling) that the backend's first cut did not yet land:
--
--   1. `donations.reverses_donation_id` — 1:1 backlink from a reversal
--      donation row to its original. The reversal is now modelled as a
--      SECOND `donations` row with negative `amount_cents`, `status='refunded'`
--      and `reverses_donation_id` set to the original — NEVER by mutating the
--      original row's status. This preserves the financial audit trail
--      (Swiss CO Art. 958f electronic archival) and makes downstream
--      aggregates (`SUM(amount_cents)` per campaign) settle to the net
--      amount without special-casing the reversal sign. Documented in
--      `docs/25` §5.2 and `adr-028` "Implementation notes" §1.
--
--      ON DELETE SET NULL is the same shape as `donations.swiss_qr_reference_id`
--      and `donations.camt_credit_entry_id` from PR #5's existing tables —
--      hard-deleting the original through the admin tool doesn't break the
--      reversal row, and the audit story stays intact.
--
--   2. `camt_credit_entries.partial_match` — boolean flag set when the
--      reconciled credit amount differs from the printed
--      `swiss_qr_references.amount_cents` (and that printed amount was
--      non-zero, i.e. NOT a donor-fills-the-amount slip). The donation is
--      STILL booked at the credited amount (the only honest value — match
--      by reference, never by amount, per ADR-028); the flag exists so
--      the operator's review history can replay the divergence, and the
--      campaign QR-tracking widget's `partialMatchCount` metric joins
--      directly from this column instead of recomputing from the
--      `swiss_qr_references.amount_cents` aggregate.
--
--      No index added — the only query path is `WHERE swiss_qr_reference_id = ?`
--      on the joined `donations` row, which already has an index. The flag
--      is essentially a denormalised cache of the partial-match audit row;
--      the source of truth stays the `camt_unreconciled_entries(reason='partial_match', status='resolved')` row.
--
-- The `camt_unreconciled_reason` ENUM already carries `partial_match` from
-- migration 0044 (the docs agent named it ahead of the reconciler emitting
-- it). No ENUM ALTER needed.
--
-- Idempotency: `ADD COLUMN IF NOT EXISTS` keeps this safe to re-apply.
-- The reversal column has no back-fill (existing rows stay NULL — they were
-- never reversals); the partial-match column defaults to FALSE for every
-- existing row (which is correct — no historical credit entry was ever
-- flagged).

-- ─── donations.reverses_donation_id ─────────────────────────────────────────

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS reverses_donation_id UUID
    REFERENCES donations(id) ON DELETE SET NULL;

-- Supports the operator's "show me the refund chain for this donation"
-- audit query: `SELECT … WHERE reverses_donation_id = $original.id`.
-- Also speeds up the receipt-revocation worker's lookup of "is this
-- donation a reversal?" via the IS NOT NULL filter.
CREATE INDEX IF NOT EXISTS donations_reverses_donation_id_idx
  ON donations (reverses_donation_id)
  WHERE reverses_donation_id IS NOT NULL;

-- ─── camt_credit_entries.partial_match ──────────────────────────────────────

ALTER TABLE camt_credit_entries
  ADD COLUMN IF NOT EXISTS partial_match BOOLEAN NOT NULL DEFAULT FALSE;
