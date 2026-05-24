-- Migration: 0075_admin_finance_dashboard_flag (Epic #434, issue #435)
--
-- Seeds the `admin.finance_dashboard` feature flag. Gates the entire
-- super-admin finance + tenant-health dashboard introduced in epic
-- #434 — every new endpoint, the React page at `/admin/finance`, the
-- sidebar nav entry, the Stripe BalanceTransaction enrichment worker
-- (SUB-WORKER #436), and the survey infrastructure that feeds the
-- tenant-health tiles.
--
-- Posture:
--   * `enabled = FALSE` — default-off until the dashboard's numbers
--     have been validated against ground-truth on at least one live
--     tenant. The KPIs aggregate cross-tenant data through
--     `systemDb`; an off-by-one in the SQL is invisible to QA until
--     real money is in the table.
--   * `scope = 'platform'` — the dashboard is super-admin-only by
--     product design (cross-tenant finance + Mobilisation Score
--     ranking). Tenant overrides are meaningless here; a tenant has
--     no "their own copy" of the platform dashboard.
--   * `tenant_override_allowed = FALSE` — follows from scope.
--   * `public = TRUE` — the super-admin appShell SSR-fetches
--     `/v1/feature-flags` to decide whether to render the sidebar
--     entry. A private projection would unconditionally hide the
--     entry and defeat the epic.
--
-- Keep label + description + scope + tenant_override_allowed + public
-- in lockstep with FEATURE_FLAG_REGISTRY in
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
VALUES (
  'admin.finance_dashboard',
  FALSE,
  'Admin · Platform finance dashboard',
  'Cross-tenant super-admin dashboard aggregating donation volume, revenue, Stripe fees, and tenant health signals (Mobilisation Score + PMF/NPS/CSAT). Off by default until live tenant numbers are validated against ground truth.',
  'platform',
  -- `tenant_override_allowed` must mirror the registry's
  -- `tenantOverrideAllowed` field (parity test catches drift).
  FALSE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
