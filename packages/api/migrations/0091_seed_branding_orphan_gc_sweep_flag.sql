-- Migration: 0091_seed_branding_orphan_gc_sweep_flag
--
-- Seeds the `branding.orphan_gc_sweep` feature flag (issue #291) — the
-- kill-switch for the nightly branding-bucket orphan-GC sweep worker
-- job (ADR-023 § Consequences; ADR-024 "drift to nightly orphan-GC").
--
-- Posture:
--   * `enabled = FALSE` — default-off (feature-flag-first rule); the
--     sweep permanently deletes objects + rows, so it only runs after
--     an explicit staff decision per environment.
--   * `scope = 'platform'` — the sweep is platform-wide; tenant
--     overrides are meaningless and ignored by the evaluator.
--   * `tenant_override_allowed = FALSE`.
--   * `public = FALSE` — internal ops flag, no donor/operator surface.
--
-- Keep label + description + scope + tenant_override_allowed + public in
-- lockstep with FEATURE_FLAG_REGISTRY in
-- `packages/shared/src/constants/feature-flags.ts`. The parity
-- integration test (`feature-flags.test.ts`) fails CI on drift.
--
-- Idempotent — `ON CONFLICT (key) DO NOTHING`.

INSERT INTO feature_flags (
  key,
  enabled,
  label,
  description,
  scope,
  tenant_override_allowed,
  public
)
VALUES
  (
    'branding.orphan_gc_sweep',
    FALSE,
    'Nightly logo storage cleanup',
    'Runs a nightly maintenance job that permanently removes logo files left behind after a logo was replaced or deleted, once a 7-day safety window has passed. Off by default: Givernance staff enable it per environment after verification.',
    'platform',
    FALSE,
    FALSE
  )
ON CONFLICT (key) DO NOTHING;
