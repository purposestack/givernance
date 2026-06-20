-- Migration: 0084_constituents_multi_type_flag (issue #465)
--
-- Seeds the `constituents.multi_type` feature flag. Gates the multi-valued
-- constituent type affordances introduced with the `types text[]` column
-- (migration 0083): the multiselect form control, the multi-badge display,
-- and the API rejection of >1 type when the flag is off.
--
-- Posture:
--   * `enabled = FALSE` — default-off. With the flag off the array still
--     backs storage, but every constituent stays single-typed: the API
--     rejects a `types` payload longer than one element, exactly matching
--     the legacy single-picklist behaviour.
--   * `scope = 'tenant'` — every NPO decides independently whether to model
--     overlapping roles.
--   * `tenant_override_allowed = TRUE` — no platform-level precondition
--     (no DKIM-style infra gate); org-admins can self-serve from
--     /settings/feature-flags.
--   * `public = TRUE` — the constituents page SSR-fetches /v1/feature-flags
--     to choose the multiselect vs single Select control.
--
-- Keep label + description + scope + tenant_override_allowed + public in
-- lockstep with FEATURE_FLAG_REGISTRY in
-- `packages/shared/src/constants/feature-flags.ts`. The parity integration
-- test (`feature-flags.test.ts`) fails CI on drift.
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
  'constituents.multi_type',
  FALSE,
  'Multiple types per constituent',
  'Lets a single constituent hold several types at once — for example someone who is both a donor and a volunteer — instead of just one. Off by default: each constituent keeps a single type until you turn this on from this page.',
  'tenant',
  TRUE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
