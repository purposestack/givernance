-- Migration: 0061_seed_advanced_filters_flag (issue #422)
--
-- Seeds the `advanced_filters` feature flag added by Epic #418. Off
-- by default — each org-admin self-serves the toggle from
-- /settings/feature-flags (scope='tenant', tenant_override_allowed=TRUE)
-- once they're ready to use advanced constituent filtering. The
-- feature relies on the indexes added in migration 0060.
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
  'advanced_filters',
  FALSE,
  'Advanced constituent filtering',
  'Enables powerful filtering capabilities with complex queries, aggregations, and pattern detection (LYBUNT, SYBUNT, recurring donors, lapsed donors, major donors). Performance-intensive feature that requires database indexes. Enable gradually to monitor impact.',
  'tenant',
  TRUE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
