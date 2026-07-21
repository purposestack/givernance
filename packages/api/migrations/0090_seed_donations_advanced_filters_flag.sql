-- Migration: 0090_seed_donations_advanced_filters_flag
--
-- Seeds the `donations.advanced_filters` feature flag (donations advanced
-- filtering — the donation-grain sibling of the constituents engine that
-- ships under the legacy-flat `advanced_filters` key).
--
-- Posture:
--   * `enabled = FALSE` — default-off (feature-flag-first rule).
--   * `scope = 'tenant'` — every NPO opts in independently.
--   * `tenant_override_allowed = FALSE` — initial rollout is
--     staff-enabled per tenant while query-performance impact is
--     monitored (constituents-engine precedent).
--   * `public = TRUE` — the donations page SSR-fetches
--     /v1/feature-flags to hide the filter-builder entry point when off.
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
    'donations.advanced_filters',
    FALSE,
    'Advanced donation filtering',
    'Enables powerful filtering on the donations list — combine conditions on amounts, dates, payment details, campaigns, funds, receipt status, and donor names, with shareable filter links. Off by default: Givernance staff turn it on for your organisation while query performance is monitored.',
    'tenant',
    FALSE,
    TRUE
  )
ON CONFLICT (key) DO NOTHING;
