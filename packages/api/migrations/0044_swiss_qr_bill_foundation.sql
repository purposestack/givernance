-- Migration: 0044_swiss_qr_bill_foundation (Epic #318)
--
-- Foundation tables for the Swiss QR-bill rail. Adds five tenant-scoped
-- tables + small extensions to `campaigns` and `donations` so the
-- postal-campaign pipeline can mint per-recipient QRR/SCOR references,
-- print Swiss QR-bills on a separate A4 sheet, and reconcile camt.053
-- statement uploads back to the donation graph.
--
-- Why each table:
--
--   * `bank_accounts`              — tenant-configured operating account
--                                    that backs QR-bill issuance. Holds
--                                    the holder name + address printed
--                                    on every slip; field caps mirror
--                                    IG QR-bill v2.4 string limits so
--                                    the renderer never has to truncate.
--   * `swiss_qr_references`        — per-recipient QRR (27-digit mod-10)
--                                    or SCOR (RF-prefixed ISO 11649)
--                                    minted at postal-export time, the
--                                    structured handle the donor's bank
--                                    echoes back in camt.053. Sibling
--                                    to `campaign_qr_codes` — both rows
--                                    are minted 1:1 per personalised
--                                    letter (Givernance opaque-token QR
--                                    on the appeal page; Swiss QR-bill
--                                    on the separate sheet) but the two
--                                    alphabets / security models / 10-yr
--                                    retention story justify separate
--                                    tables (epic §2 rationale).
--   * `camt_statements`            — uploaded ISO 20022 camt.053 file
--                                    metadata. Raw XML lives in S3
--                                    `bank-statements/{org_id}/camt053/...`
--                                    (10-yr Swiss CO Art. 958f
--                                    retention); this row carries the
--                                    `GrpHdr.MsgId` idempotency key +
--                                    status surface for the worker.
--   * `camt_credit_entries`        — one row per `Ntry` we observed
--                                    (always inserted, matched or not).
--                                    Idempotent on `(statement_id,
--                                    AcctSvcrRef)`; donor name + IBAN
--                                    captured for QA + foreign-IBAN
--                                    safety. `donation_id` is set by
--                                    the reconciler when the structured
--                                    reference matches a row in
--                                    `swiss_qr_references`.
--   * `camt_unreconciled_entries`  — manual-review queue for credits
--                                    the auto-matcher couldn't resolve
--                                    (no QR ref / format failure /
--                                    foreign IBAN / orphan reversal).
--                                    1:1 with `camt_credit_entries` —
--                                    the unique on `credit_entry_id`
--                                    enforces it.
--
-- Extensions on existing tables:
--
--   * `campaigns.bank_account_id`     — nullable FK; presence IS the
--                                       "Swiss QR-bill mode on" switch
--                                       (no separate boolean — an
--                                       `enabled=true && bank_account_id=NULL`
--                                       state has no operator meaning).
--                                       ON DELETE SET NULL: soft-deleting
--                                       the bank account degrades the
--                                       campaign back to standard mode.
--   * `campaigns.qr_reference_mode`   — `auto` (default — derive from
--                                       `bank_accounts.iban_kind`),
--                                       `qrr`, or `scor`. Operator
--                                       override for the few banks that
--                                       support both. Ignored when
--                                       `bank_account_id IS NULL`.
--   * `donations.swiss_qr_reference_id` — set by camt reconciler.
--   * `donations.camt_credit_entry_id`  — 1:1 raw bank line, for audit.
--   * `donations.payment_source`        — origin rail discriminator.
--                                         `stripe` default for back-compat
--                                         with existing rows.
--
-- RLS: every new table is tenant-scoped via the standard
--      `tenant_isolation` policy keyed on `org_id`. Reads happen
--      exclusively through `withTenantContext` / `withWorkerContext`.
--
-- Idempotency: re-running on a fresh checkout is a no-op
--              (`IF NOT EXISTS`, `EXCEPTION WHEN duplicate_object`).

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE bank_account_iban_kind AS ENUM ('iban', 'qr_iban');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE bank_account_currency AS ENUM ('CHF', 'EUR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE swiss_qr_reference_type AS ENUM ('qrr', 'scor');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE camt_statement_status AS ENUM ('pending', 'processing', 'processed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE camt_unreconciled_reason AS ENUM (
    'no_match',
    'partial_match',
    'invalid_ref',
    'foreign_iban',
    'orphan_reversal',
    -- Door-drop rail only: QR ref matched a NULL-constituent row but
    -- the camt.053 entry carried no `RltdPties.Dbtr` info, so the
    -- reconciler couldn't auto-resolve a constituent. Rare in
    -- practice (mostly TWINT-rail credits); operator resolves manually.
    'no_debtor_info'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE camt_unreconciled_status AS ENUM ('pending', 'resolved', 'written_off');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_qr_reference_mode AS ENUM ('auto', 'qrr', 'scor');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE donation_payment_source AS ENUM ('stripe', 'camt053', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── bank_accounts ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                      UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID                       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- IG QR-bill v2.4 / v2.5 structured-address (S) caps:
  -- holder_name ≤70, street ≤70, building_number ≤16, postal_code ≤16,
  -- town ≤35, country exactly 2. Enforcing them at the column level
  -- guarantees the renderer never has to truncate; the API also caps
  -- inputs but the DB is the last line of defence. Combined address
  -- (K) is not modelled — v2.5 makes S mandatory from 2026-09-30; we
  -- ship S-only by construction so no migration is needed at cutover.
  holder_name             VARCHAR(70)                NOT NULL,
  holder_street           VARCHAR(70)                NOT NULL,
  holder_building_number  VARCHAR(16),
  holder_postal_code      VARCHAR(16)                NOT NULL,
  holder_town             VARCHAR(35)                NOT NULL,
  -- ISO 3166-1 alpha-2. VARCHAR(2) — not CHAR(2): CHAR blank-pads to
  -- length 2 which trips equality comparisons in COALESCE/joins.
  -- Restricted to CH/LI by a CHECK constraint below.
  holder_country_code     VARCHAR(2)                 NOT NULL DEFAULT 'CH',
  -- Stored canonical: no whitespace, uppercase. CH/LI are 21 chars;
  -- VARCHAR(34) covers the global IBAN max for completeness.
  iban                    VARCHAR(34)                NOT NULL,
  iban_kind               bank_account_iban_kind     NOT NULL,
  -- 8 or 11 chars when present (ISO 9362). Nullable because the
  -- operator may not know the BIC at registration time and the
  -- QR-bill payload itself doesn't require it.
  bic                     VARCHAR(11),
  bank_name               VARCHAR(100)               NOT NULL,
  currency                bank_account_currency      NOT NULL DEFAULT 'CHF',
  -- Soft-delete marker. Once a bank account has issued a single
  -- `swiss_qr_references` row it cannot be hard-deleted (FK with
  -- ON DELETE RESTRICT on that table); soft-delete is the standard
  -- removal path. Linked campaigns degrade gracefully via the
  -- `campaigns.bank_account_id` ON DELETE SET NULL FK below.
  deleted_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ                NOT NULL DEFAULT NOW()
);

-- Country restricted to the IG QR-bill scope. Defence-in-depth — the
-- API validator enforces the same rule but a future migration / ETL
-- path should not be able to insert e.g. a French IBAN here.
DO $$ BEGIN
  ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_country_chk
    CHECK (holder_country_code IN ('CH', 'LI'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- BIC (SWIFT code) — ISO 9362 mandates exactly 8 or 11 characters.
-- NULL allowed (operator may not know it at registration time).
DO $$ BEGIN
  ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_bic_length_chk
    CHECK (bic IS NULL OR length(bic) IN (8, 11));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- IBAN must be stored canonical: uppercase alphanumerics only (no
-- whitespace). The API validator does this normalisation at the
-- boundary; this CHECK is the last-line-of-defence against a worker
-- path that bypassed it.
DO $$ BEGIN
  ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_iban_canonical_chk
    CHECK (iban ~ '^[A-Z0-9]+$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS bank_accounts_org_idx
  ON bank_accounts (org_id);

-- Partial unique: same IBAN can be re-added after soft-delete (the
-- previous row stays for audit). Drizzle Kit doesn't model partial
-- uniques so the type-side declaration is unconditional; this index
-- is the source of truth.
DROP INDEX IF EXISTS bank_accounts_org_iban_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_org_iban_uniq
  ON bank_accounts (org_id, iban)
  WHERE deleted_at IS NULL;

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON bank_accounts
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_accounts TO givernance_app;

-- ─── swiss_qr_references ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS swiss_qr_references (
  id                UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID                       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id       UUID                       NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  -- Nullable because door-drop mints one ref per export with no
  -- recipient. SET NULL on constituent erasure (GDPR Art. 17) keeps
  -- the campaign-level rollup KPI intact while clearing the donor
  -- pointer.
  constituent_id    UUID                       REFERENCES constituents(id) ON DELETE SET NULL,
  -- Backlink to the export run that minted this reference. Lets the
  -- worker detect on retry that references already exist for this
  -- export and reuse them instead of minting fresh ones on every
  -- BullMQ retry (Kamal pod crash mid-export). CASCADE — if the
  -- export row is deleted (manual cleanup), the reference rows go
  -- with it; financial idempotency is enforced by the reconciler
  -- elsewhere (`donations.payment_ref` partial unique).
  export_id         UUID                       NOT NULL REFERENCES campaign_postal_exports(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: a bank account that has ever issued a
  -- reference cannot be hard-deleted. Soft-delete still works —
  -- `bank_accounts.deleted_at` lives on the parent row.
  bank_account_id   UUID                       NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  reference_type    swiss_qr_reference_type    NOT NULL,
  -- 27 digits (QRR) or `RF` + ≤23 alnum (SCOR); 40 leaves comfortable
  -- headroom for either format including any space-delimited render
  -- snapshot we may want to keep alongside the canonical.
  reference         VARCHAR(40)                NOT NULL,
  -- 0 = donor-fills the amount in their e-banking app (the standard
  -- Swiss UX for fundraising appeals). Non-zero = pre-printed
  -- suggested amount.
  amount_cents      BIGINT                     NOT NULL DEFAULT 0,
  currency          VARCHAR(3)                 NOT NULL,
  created_at        TIMESTAMPTZ                NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS swiss_qr_references_org_idx
  ON swiss_qr_references (org_id);
CREATE INDEX IF NOT EXISTS swiss_qr_references_campaign_idx
  ON swiss_qr_references (campaign_id);
CREATE INDEX IF NOT EXISTS swiss_qr_references_export_idx
  ON swiss_qr_references (export_id);
-- FK index — supports ON DELETE RESTRICT lookups when soft-deleting
-- a bank account, and the reconciler's `JOIN bank_accounts` path.
-- Without it, every soft-delete-or-reconcile triggers a sequential
-- scan on this table as it grows.
CREATE INDEX IF NOT EXISTS swiss_qr_references_bank_account_idx
  ON swiss_qr_references (bank_account_id);

-- Amount cap — IG QR-bill v2.4 §4.3.6: amount range 0.00 – 999,999,999.99
-- (i.e. ≤ 99,999,999,999 cents). 0 = donor fills the amount in their
-- e-banking app (the standard Swiss UX for fundraising appeals).
DO $$ BEGIN
  ALTER TABLE swiss_qr_references ADD CONSTRAINT swiss_qr_references_amount_chk
    CHECK (amount_cents BETWEEN 0 AND 99999999999);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Currency restricted to IG QR-bill v2.4 §4.3.6: only CHF and EUR are
-- valid on a Swiss QR-bill. The `bank_accounts.currency` column uses a
-- typed enum (`bank_account_currency`); on this table we keep VARCHAR(3)
-- for ergonomic JOINs with other rails and constrain via CHECK.
DO $$ BEGIN
  ALTER TABLE swiss_qr_references ADD CONSTRAINT swiss_qr_references_currency_chk
    CHECK (currency IN ('CHF', 'EUR'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The reference IS the universal donor handle (it's what the bank
-- prints on the slip and echoes back in camt.053). It must be unique
-- per bank account — collisions break reconciliation.
ALTER TABLE swiss_qr_references
  DROP CONSTRAINT IF EXISTS swiss_qr_references_org_bank_ref_uniq;
ALTER TABLE swiss_qr_references
  ADD CONSTRAINT swiss_qr_references_org_bank_ref_uniq
  UNIQUE (org_id, bank_account_id, reference);

-- Partial unique with COALESCE for retry-idempotency: one reference
-- per `(export_id, COALESCE(constituent_id, sentinel))`. The COALESCE
-- collapses NULL constituent_id to a sentinel UUID so door-drop
-- (NULL recipient) cannot accumulate duplicates on retry — Postgres
-- treats NULL as distinct in regular unique indexes, so without the
-- COALESCE we'd lose idempotency on the door-drop path. Same trick
-- used for `campaign_qr_codes_export_recipient_uniq` in migration
-- 0040. Drizzle Kit cannot model expression-based uniques, so this
-- index lives in the migration only — see ADR-027 §"Decision" for
-- the explicit constraint declaration.
ALTER TABLE swiss_qr_references
  DROP CONSTRAINT IF EXISTS swiss_qr_references_export_constituent_uniq;
DROP INDEX IF EXISTS swiss_qr_references_export_constituent_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS swiss_qr_references_export_recipient_uniq
  ON swiss_qr_references (
    export_id,
    COALESCE(constituent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE swiss_qr_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE swiss_qr_references FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON swiss_qr_references
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON swiss_qr_references TO givernance_app;

-- ─── camt_statements ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS camt_statements (
  id                  UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID                       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: the audit story "show me every statement
  -- ever imported for this account" must outlive the soft-delete of
  -- the bank account itself.
  bank_account_id     UUID                       NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  -- S3 key (private `bank-statements` bucket, 10-yr lifecycle).
  s3_path             VARCHAR(500)               NOT NULL,
  -- ISO 20022 `GrpHdr.MsgId` — file-level idempotency. Re-uploading
  -- the same file is a deliberate no-op via the unique constraint
  -- below, not a duplicate import.
  msg_id              VARCHAR(255)               NOT NULL,
  statement_from      DATE,
  statement_to        DATE,
  total_credits       INTEGER                    NOT NULL DEFAULT 0,
  matched_credits     INTEGER                    NOT NULL DEFAULT 0,
  unmatched_credits   INTEGER                    NOT NULL DEFAULT 0,
  status              camt_statement_status      NOT NULL DEFAULT 'pending',
  -- Captured error message on terminal failure. Surfaced to the admin
  -- UI as a generic toast; structured worker logs carry the stack.
  error               TEXT,
  uploaded_by         UUID                       REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS camt_statements_org_idx
  ON camt_statements (org_id);
CREATE INDEX IF NOT EXISTS camt_statements_bank_account_idx
  ON camt_statements (bank_account_id);
CREATE INDEX IF NOT EXISTS camt_statements_status_idx
  ON camt_statements (status);

-- ISO 20022 caps `GrpHdr.MsgId` at 35 chars. The column allows 255 for
-- forward-compat with vendor extensions but the CHECK locks in the spec
-- bound — defends against a malicious or malformed upload trying to
-- consume the unique-index keyspace with attacker-controlled long strings.
DO $$ BEGIN
  ALTER TABLE camt_statements ADD CONSTRAINT camt_statements_msg_id_length_chk
    CHECK (length(msg_id) <= 35);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE camt_statements
  DROP CONSTRAINT IF EXISTS camt_statements_org_msg_id_uniq;
ALTER TABLE camt_statements
  ADD CONSTRAINT camt_statements_org_msg_id_uniq
  UNIQUE (org_id, msg_id);

ALTER TABLE camt_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE camt_statements FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON camt_statements
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON camt_statements TO givernance_app;

-- ─── camt_credit_entries ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS camt_credit_entries (
  id                  UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID                       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_id        UUID                       NOT NULL REFERENCES camt_statements(id) ON DELETE CASCADE,
  -- ISO 20022 `Ntry.AcctSvcrRef` — entry-level idempotency. Some
  -- banks reuse this across related entries; we de-dup on the
  -- canonical (statement_id, AcctSvcrRef) tuple and keep the
  -- end_to_end_id below as a secondary signal for QA cross-checks.
  acct_svcr_ref       VARCHAR(255)               NOT NULL,
  end_to_end_id       VARCHAR(255),
  amount_cents        BIGINT                     NOT NULL,
  currency            VARCHAR(3)                 NOT NULL,
  value_date          DATE,
  booking_date        DATE,
  -- Extracted QRR/SCOR if `RmtInf.Strd.CdtrRefInf.Ref` was present.
  -- NULL when the donor's bank dropped the reference (rare — usually
  -- a sign of a counter payment or e-banking edit gone wrong).
  structured_ref      VARCHAR(40),
  debtor_name         VARCHAR(255),
  debtor_iban         VARCHAR(34),
  -- Set by the reconciler when the structured reference matches a
  -- row in `swiss_qr_references`. ON DELETE SET NULL: a hard-deleted
  -- donation (admin-tool path) doesn't leave a dangling FK on the
  -- credit-entry row — financial provenance stays.
  donation_id         UUID                       REFERENCES donations(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ                NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS camt_credit_entries_org_idx
  ON camt_credit_entries (org_id);
CREATE INDEX IF NOT EXISTS camt_credit_entries_statement_idx
  ON camt_credit_entries (statement_id);
CREATE INDEX IF NOT EXISTS camt_credit_entries_donation_idx
  ON camt_credit_entries (donation_id);

-- ISO 20022 caps `Ntry.AcctSvcrRef` and `EndToEndId` at 35 chars each.
-- Columns are VARCHAR(255) for vendor-extension headroom; CHECKs lock
-- the spec bound so a malformed upload can't bloat the unique-index
-- keyspace below.
DO $$ BEGIN
  ALTER TABLE camt_credit_entries ADD CONSTRAINT camt_credit_entries_acct_svcr_ref_length_chk
    CHECK (length(acct_svcr_ref) <= 35);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE camt_credit_entries ADD CONSTRAINT camt_credit_entries_end_to_end_id_length_chk
    CHECK (end_to_end_id IS NULL OR length(end_to_end_id) <= 35);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Debtor IBAN must be stored canonical (uppercase alnum, no whitespace).
-- The reconciler normalises at the parser boundary; this CHECK is the
-- last-line-of-defence against drift on a worker direct-INSERT path.
DO $$ BEGIN
  ALTER TABLE camt_credit_entries ADD CONSTRAINT camt_credit_entries_debtor_iban_canonical_chk
    CHECK (debtor_iban IS NULL OR debtor_iban ~ '^[A-Z0-9]+$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Entry-level idempotency tuple. We include `end_to_end_id` (with
-- COALESCE for NULLs) because some banks reuse `AcctSvcrRef` across
-- related Ntry rows that share a statement; the `EndToEndId` then
-- disambiguates them. ADR-028 §Idempotency: this matches the SIX
-- recommendation for QR-bill reconciliation. Expression-based unique
-- = expressed as an index, not a constraint.
ALTER TABLE camt_credit_entries
  DROP CONSTRAINT IF EXISTS camt_credit_entries_org_statement_acctsvcr_uniq;
DROP INDEX IF EXISTS camt_credit_entries_org_statement_acctsvcr_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS camt_credit_entries_org_statement_entry_uniq
  ON camt_credit_entries (
    org_id,
    statement_id,
    acct_svcr_ref,
    COALESCE(end_to_end_id, '')
  );

ALTER TABLE camt_credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE camt_credit_entries FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON camt_credit_entries
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON camt_credit_entries TO givernance_app;

-- ─── camt_unreconciled_entries ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS camt_unreconciled_entries (
  id                 UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID                          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 1:1 with `camt_credit_entries` — the unique below enforces it.
  -- CASCADE so a hard-purged statement (rare manual cleanup) doesn't
  -- leave orphan queue rows.
  credit_entry_id    UUID                          NOT NULL REFERENCES camt_credit_entries(id) ON DELETE CASCADE,
  reason             camt_unreconciled_reason      NOT NULL,
  status             camt_unreconciled_status      NOT NULL DEFAULT 'pending',
  -- ON DELETE SET NULL preserves audit history through GDPR erasures
  -- of an offboarded operator.
  resolved_by        UUID                          REFERENCES users(id) ON DELETE SET NULL,
  resolved_at        TIMESTAMPTZ,
  resolution_note    TEXT,
  created_at         TIMESTAMPTZ                   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ                   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS camt_unreconciled_entries_org_idx
  ON camt_unreconciled_entries (org_id);
CREATE INDEX IF NOT EXISTS camt_unreconciled_entries_status_idx
  ON camt_unreconciled_entries (status);

ALTER TABLE camt_unreconciled_entries
  DROP CONSTRAINT IF EXISTS camt_unreconciled_entries_credit_entry_uniq;
ALTER TABLE camt_unreconciled_entries
  ADD CONSTRAINT camt_unreconciled_entries_credit_entry_uniq
  UNIQUE (credit_entry_id);

ALTER TABLE camt_unreconciled_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE camt_unreconciled_entries FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON camt_unreconciled_entries
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON camt_unreconciled_entries TO givernance_app;

-- ─── campaigns extension ────────────────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS bank_account_id UUID
    REFERENCES bank_accounts(id) ON DELETE SET NULL;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS qr_reference_mode campaign_qr_reference_mode
    NOT NULL DEFAULT 'auto';

-- ─── donations extension ────────────────────────────────────────────────────

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS swiss_qr_reference_id UUID
    REFERENCES swiss_qr_references(id) ON DELETE SET NULL;

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS camt_credit_entry_id UUID
    REFERENCES camt_credit_entries(id) ON DELETE SET NULL;

-- DEFAULT 'stripe' covers the back-compat path: every existing row
-- predates this migration and is by definition Stripe-rail. New
-- camt053-rail rows set this explicitly via the reconciler.
ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS payment_source donation_payment_source
    NOT NULL DEFAULT 'stripe';
