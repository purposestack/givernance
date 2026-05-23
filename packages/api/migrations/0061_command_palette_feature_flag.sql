-- Migration: 0061_command_palette_feature_flag
--
-- Seeds the `productivity.command_palette` feature flag added in Epic
-- #364 (GLO-001). Off by default; each org-admin self-serves the toggle
-- from /settings/feature-flags (scope='tenant', tenant_override_allowed=TRUE)
-- once they're ready to roll out the global Cmd+K search to their team —
-- no platform-level precondition like DKIM, only operational caution
-- while we monitor performance and search-quality signals.
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
  'productivity.command_palette',
  FALSE,
  'Keyboard quick search (Cmd+K / Ctrl+K)',
  'Adds a quick search panel that opens with Cmd+K (Mac) or Ctrl+K (Windows / Linux) from any page. Type to find a constituent, donation, or campaign, jump to a section, or start a new record. Off by default while we monitor performance and search quality — flip it on from this page when you''re ready.',
  'tenant',
  TRUE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
