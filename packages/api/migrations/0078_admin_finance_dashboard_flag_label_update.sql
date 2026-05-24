-- Migration: 0078_admin_finance_dashboard_flag_label_update (Epic #434)
--
-- Re-aligns the `admin.finance_dashboard` feature flag's label +
-- description to English on any environment that already received
-- the prior French strings from an earlier 0075 run. Migration 0075
-- is `ON CONFLICT (key) DO NOTHING`, so once the row exists, the
-- label/description never refresh — this migration is the explicit
-- repair. Idempotent: if the row is already English (fresh CI), the
-- UPDATE is a no-op SET to the same values.
--
-- The new strings mirror FEATURE_FLAG_REGISTRY in
-- `packages/shared/src/constants/feature-flags.ts` and are
-- enforced by the parity integration test.

UPDATE feature_flags
SET
  label = 'Admin · Platform finance dashboard',
  description = 'Cross-tenant super-admin dashboard aggregating donation volume, revenue, Stripe fees, and tenant health signals (Mobilisation Score + PMF/NPS/CSAT). Off by default until live tenant numbers are validated against ground truth.'
WHERE key = 'admin.finance_dashboard';
