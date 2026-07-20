-- Migration: 0089_custom_fields_flags (Epic #539)
--
-- Seeds the three per-domain custom-field feature flags:
-- `constituents.custom_fields`, `donations.custom_fields`,
-- `campaigns.custom_fields`. One flag per domain — deliberate kill
-- switches so a problem confined to one surface can be disabled without
-- pulling the whole customization engine. Erasure hooks are NEVER
-- flag-gated; the flags gate operator/admin affordances only.
--
-- Posture (identical across the three):
--   * `enabled = FALSE` — default-off (feature-flag-first rule).
--   * `scope = 'tenant'` — every NPO opts in independently.
--   * `tenant_override_allowed = FALSE` — initial rollout is
--     staff-enabled per tenant after a CSM walk-through of the field
--     builder + quota meter (bulk-email precedent). Graduation to
--     org-admin self-service is Epic #539 open question #6.
--   * `public = TRUE` — settings tabs, forms, list columns, filter
--     categories, and export buttons SSR-fetch /v1/feature-flags to
--     hide their surfaces when off.
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
    'constituents.custom_fields',
    FALSE,
    'Custom fields on constituents',
    'Lets your organisation define its own typed fields on constituent records — text, numbers, dates, checkboxes, amounts, and picklists with managed options — then fill, filter, and export them like any built-in field. Off by default: Givernance staff turn it on for your organisation during the initial rollout.',
    'tenant',
    FALSE,
    TRUE
  ),
  (
    'donations.custom_fields',
    FALSE,
    'Custom fields on donations',
    'Lets your organisation define its own typed fields on donation records — for example an internal reference or a thematic classification — then fill and export them like any built-in field. Off by default: Givernance staff turn it on for your organisation during the initial rollout.',
    'tenant',
    FALSE,
    TRUE
  ),
  (
    'campaigns.custom_fields',
    FALSE,
    'Custom fields on campaigns',
    'Lets your organisation define its own typed fields on campaign records — for example a budget code or an audience segment — then fill and export them like any built-in field. Off by default: Givernance staff turn it on for your organisation during the initial rollout.',
    'tenant',
    FALSE,
    TRUE
  )
ON CONFLICT (key) DO NOTHING;
