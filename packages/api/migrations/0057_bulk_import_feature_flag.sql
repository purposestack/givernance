-- Migration: 0057_bulk_import_feature_flag
--
-- Seeds the `constituents.bulk_import` feature flag added in Epic #373
-- (PR #385). Off by default; each org-admin self-serves the toggle from
-- /settings/feature-flags (scope='tenant', tenant_override_allowed=TRUE)
-- once they're ready to use bulk imports — no platform-level
-- precondition like DKIM, only operational caution.
--
-- Idempotent: `ON CONFLICT (key) DO NOTHING` so existing values
-- (including operator-toggled `enabled`) are preserved across redeploys.
--
-- Keep `label` + `description` + `scope` + `tenant_override_allowed`
-- + `public` in lockstep with FEATURE_FLAG_REGISTRY in
-- `packages/shared/src/constants/feature-flags.ts`. The parity
-- integration test (`feature-flags.test.ts`) fails CI on drift.

INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
VALUES (
  'constituents.bulk_import',
  FALSE,
  'Bulk import constituents from CSV / Excel',
  'Lets operators upload a CSV or Excel file (max 10 MB) to create constituents in bulk, with duplicate detection and a per-row progress view. Off by default while we monitor the first real-world imports — flip it on from this page when you''re ready.',
  'tenant',
  TRUE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
