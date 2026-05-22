-- Migration 0063: Seed feature flags for multi-currency (ADR-031, Epic #416 Task 8)
--
-- Seeds two feature flags introduced by the multi-currency Epic:
--
--   donation.multi_currency — gates the currency-selector at checkout,
--     Fixer.io FX-rate worker, and per-donation settlement-currency
--     conversion logic. Requires the FX cache to be warm before enabling.
--
--   donation.fund_routing — gates the campaign → fund split-percentage
--     CRUD endpoints (added in Task 4). Requires the end-to-end
--     split-payment flow to be verified on staging before any tenant sees it.
--
-- Both flags are:
--   * `enabled = FALSE` — off by default; super-admin controls the gate.
--   * `scope = 'platform'` — platform-level preconditions (FX cache,
--     Stripe settlement-currency detection) must be verified before
--     exposing to any tenant. Tenant overrides are ignored by the
--     evaluator while scope is 'platform'.
--   * `tenant_override_allowed = FALSE` — super-admin gate only.
--   * `public = FALSE` — not projected into the tenant-facing
--     `/v1/feature-flags` endpoint; enforcement is server-side.
--
-- See:
--   - `packages/shared/src/constants/feature-flags.ts` — FEATURE_FLAG_REGISTRY
--     entries for DONATION_MULTI_CURRENCY and DONATION_FUND_ROUTING.
--     The parity integration test in
--     `packages/api/src/tests/integration/feature-flags.test.ts`
--     asserts label + description + scope + tenant_override_allowed +
--     public match between these rows and the registry. Drift fails CI.
--   - `docs/adrs/adr-031-multi-currency-strategy.md` — ADR governing
--     the multi-currency approach.
--
-- Idempotent — `ON CONFLICT (key) DO NOTHING` so a redeploy preserves
-- any super-admin-toggled value. Migrations are immutable once applied;
-- a future adjustment to label/description goes in a new migration.

INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
VALUES
  (
    'donation.multi_currency',
    false,
    'Multi-currency checkout support',
    'Enables dynamic currency selection at checkout based on Stripe settlement currencies. Requires Fixer.io cache to be populated.',
    'platform',
    false,
    false
  ),
  (
    'donation.fund_routing',
    false,
    'Campaign → fund routing',
    'Enables assigning multiple funds to a campaign with split percentages. Required for multi-fund donation allocation.',
    'platform',
    false,
    false
  )
ON CONFLICT (key) DO NOTHING;
