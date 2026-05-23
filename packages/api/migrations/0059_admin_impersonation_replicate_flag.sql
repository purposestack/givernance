-- Migration: 0059_admin_impersonation_replicate_flag (issue #428)
--
-- Seeds the `admin.impersonation_replicate` feature flag. The flag
-- gates the Replicate row-action on the Back Office impersonation
-- list (`/admin/impersonation`) — one click re-POSTs against
-- `/v1/admin/impersonation` with the original session's target /
-- mode / reason, reusing the existing 5-min MFA-fresh window
-- (`STEP_UP_AUTH_TIME_WINDOW_SECONDS` in
-- `packages/api/src/lib/impersonation/step-up.ts`).
--
-- See:
--   - `packages/shared/src/constants/feature-flags.ts` — code-side
--     `FEATURE_FLAG_REGISTRY` entry (`ADMIN_IMPERSONATION_REPLICATE`).
--     The parity integration test in
--     `packages/api/src/tests/integration/feature-flags.test.ts`
--     asserts label + description + scope + tenant_override_allowed +
--     public match between this row and the registry. Drift fails CI.
--   - `docs/19-impersonation.md` § 4 — Session lifecycle, including
--     the new "Replicating a past session" sub-section.
--
-- Posture:
--   * `enabled = FALSE` — every deploy ships with the flag off so
--     the past-sessions list looks identical to what super-admins
--     see today until staff flip it on. No big-bang UI change for
--     in-flight investigations.
--   * `scope = 'platform'` — this is a Givernance-staff productivity
--     feature, not a tenant capability. The button only ever renders
--     for `super_admin`, so a tenant override would be meaningless.
--   * `tenant_override_allowed = FALSE` — paired with `platform`
--     scope; tenants have no business with this flag.
--   * `public = TRUE` — the list page SSR-fetches
--     `/v1/feature-flags` to decide whether to render the Replicate
--     cell. A private projection would unconditionally hide the
--     surface and defeat the Epic.
--
-- Idempotent — `ON CONFLICT (key) DO NOTHING` so a redeploy preserves
-- any super-admin-toggled value. Migrations are immutable once
-- applied (per `feedback_never_modify_applied_migrations`); a future
-- adjustment to label/description goes in a NEW migration.

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
  'admin.impersonation_replicate',
  FALSE,
  'One-click replicate of past impersonation sessions',
  'Adds a Replicate button next to every past support session on the impersonation list, so a Givernance staffer can re-enter the same session in one click without retyping the target, mode, and reason. The same MFA step-up rules still apply.',
  'platform',
  FALSE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
