-- Migration: 0081_postal_export_merged_pdf (project item #194221573)
--
-- "Export PDF unique multi-pages (1 page/constituant)".
--
-- The postal export (Epic #274) always produced a ZIP of one PDF per
-- recipient. This migration ships the schema + flag for a second output
-- format — a single concatenated multi-page PDF — selectable per export.
--
-- 1. `campaign_postal_exports.format` — the chosen output format.
--    Typed text + CHECK rather than a pg enum to avoid a `CREATE TYPE`
--    round-trip (same pattern as the constrained `run_mode` text column).
--    Default `'zip'` + NOT NULL so every historical row reads as a ZIP,
--    preserving the original behaviour with no backfill.
--
-- 2. `campaign.postal_merged_pdf` feature flag — gates the format
--    selector + the `format=merged_pdf` request path. Default-off so the
--    in-memory merge profile + recipient cap can be validated on staging
--    before a platform-wide enable. Keep label/description/scope/
--    tenant_override_allowed/public in lockstep with FEATURE_FLAG_REGISTRY
--    in `packages/shared/src/constants/feature-flags.ts` — the parity
--    integration test (`feature-flags.test.ts`) fails CI on drift.
--
-- Both steps are idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`).

ALTER TABLE campaign_postal_exports
  ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'zip';

-- Constrain to the two known formats. Named so a future format addition
-- drops + recreates the CHECK in its own migration rather than editing
-- this (applied) one.
ALTER TABLE campaign_postal_exports
  DROP CONSTRAINT IF EXISTS campaign_postal_exports_format_chk;
ALTER TABLE campaign_postal_exports
  ADD CONSTRAINT campaign_postal_exports_format_chk
  CHECK (format IN ('zip', 'merged_pdf'));

INSERT INTO feature_flags (
  key,
  enabled,
  label,
  description,
  scope,
  tenant_override_allowed,
  public
)
VALUES (
  'campaign.postal_merged_pdf',
  FALSE,
  'Single merged PDF for postal mailings',
  'Adds an option to download a postal mailing as one combined PDF (one page per recipient) instead of a ZIP of separate files — handy for sending the whole batch straight to a printer. Off by default: exports stay as a ZIP until Givernance staff turn this on for your organisation. Very large mailings always use the ZIP.',
  'tenant',
  FALSE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
