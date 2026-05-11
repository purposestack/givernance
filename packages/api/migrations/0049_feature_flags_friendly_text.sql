-- Migration: 0049_feature_flags_friendly_text (PR #352 magino UX review)
--
-- Adds the operator-facing `label` column to `feature_flags` and
-- rewrites the bulk-email row's text in plain language. The Back
-- Office UI was previously rendering engineering jargon
-- ("communication.bulk_email", "DKIM / SPF / DMARC", "issue #326")
-- to non-technical super-admins, which read more like a deploy ticket
-- than an operator control.
--
-- Why this is a separate migration (not folded into 0047): an earlier
-- iteration of this PR modified 0047 in place to add the column. That
-- broke any environment where 0047 had already been applied — the
-- idempotent `CREATE TABLE IF NOT EXISTS` silently skipped the
-- re-run, leaving the DB without the `label` column and the
-- `/v1/admin/feature-flags` route 500-ing on a missing column. Lesson:
-- once a migration is applied anywhere (even local dev), treat it as
-- immutable. Additive schema + data fixes belong in a NEW migration.
--
-- Three-step shape:
--   1. Add `label` as NULLABLE (existing rows need a back-fill window).
--   2. UPDATE the seeded row(s) with both `label` and the rewritten
--      friendly `description`. Idempotent — re-running won't change
--      operator-toggled `enabled`.
--   3. Promote `label` to NOT NULL. Safe by step 2: every seeded row
--      now has the column populated.
--
-- Idempotent — every step uses `IF NOT EXISTS` / unconditional UPDATE,
-- so re-runs on a fresh checkout are no-ops.

-- ─── 1. Add the column as NULLABLE ──────────────────────────────────────────

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS label VARCHAR(120);

-- ─── 2. Back-fill + rewrite the bulk-email row ──────────────────────────────
-- Keep the SQL `label` + `description` in lockstep with the
-- `FEATURE_FLAG_REGISTRY` entry in
-- `packages/shared/src/constants/feature-flags.ts`. The integration
-- test in `feature-flags.test.ts` asserts the parity and fails CI on
-- drift.

UPDATE feature_flags
SET
  label = 'Bulk emails to constituents',
  description = 'Lets operators send one email to several constituents at once from the Constituents page. Currently off — we''ll turn it on once the email-deliverability setup is finished so messages don''t land in donors'' spam folders.',
  updated_at = NOW()
WHERE key = 'communication.bulk_email';

-- ─── 3. Promote `label` to NOT NULL ─────────────────────────────────────────
-- Wrapped in a DO block so re-applying against a DB where the column
-- is already NOT NULL is a no-op rather than an error.

DO $$
BEGIN
  ALTER TABLE feature_flags
    ALTER COLUMN label SET NOT NULL;
EXCEPTION
  WHEN invalid_table_definition THEN NULL;
END $$;
