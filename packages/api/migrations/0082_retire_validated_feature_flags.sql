-- Migration: 0082_retire_validated_feature_flags (issue #493)
--
-- Retires five feature flags whose features have been validated in
-- production and are now permanently part of the product. The gating
-- code (requireFlag preHandlers, worker isFlagEnabled early-returns,
-- SSR xEnabled plumbing) is removed in the same PR; this migration
-- drops the now-orphaned seed rows so the registry ↔ DB parity test
-- (`packages/api/src/tests/integration/feature-flags.test.ts`) stays
-- green after the registry entries are gone.
--
-- Retired keys:
--   admin.feature_flags_phase2          (gate only — the admin tooling stays)
--   admin.finance_dashboard
--   admin.impersonation_replicate
--   communication.notifications_center
--   productivity.command_palette
--
-- NOTE on admin.feature_flags_phase2: only its OWN gate is retired. The
-- per-org flag-administration tooling it used to gate (override
-- endpoints, /settings/feature-flags, the per-tenant tab, overrideStats)
-- stays — the remaining flags still rely on it.
--
-- FK order: `tenant_flag_overrides.flag_key` REFERENCES `feature_flags(key)`
-- ON DELETE CASCADE, so deleting the flag rows would cascade anyway. We
-- delete the override rows first explicitly so the intent is auditable and
-- the migration does not depend on the cascade staying in place.
--
-- The original seed migrations (0051, 0055, 0059, 0061, 0075, 0078) are
-- immutable and stay untouched — this is an additive retirement migration.

DELETE FROM tenant_flag_overrides
WHERE flag_key IN (
  'admin.feature_flags_phase2',
  'admin.finance_dashboard',
  'admin.impersonation_replicate',
  'communication.notifications_center',
  'productivity.command_palette'
);

DELETE FROM feature_flags
WHERE key IN (
  'admin.feature_flags_phase2',
  'admin.finance_dashboard',
  'admin.impersonation_replicate',
  'communication.notifications_center',
  'productivity.command_palette'
);
