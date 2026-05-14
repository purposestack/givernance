-- Migration: 0053_donation_public_page_styles_flag (Epic #362, spike PR)
--
-- Seeds the `donation.public_page_styles` feature flag. This is the
-- gate for the public donation page style-archetype system —
-- 10 distinct visual archetypes (Foundation, Activist, Editorial Story,
-- Minimal Checkout, Emergency Appeal, Neo-Brutalist, Calm Wellness,
-- Civic Modern, Retro Print, Cosmic Gradient) the operator can pick
-- from for `/p/[id]`.
--
-- See:
--   - `packages/shared/src/constants/feature-flags.ts` — code-side
--     `FEATURE_FLAG_REGISTRY` entry (`DONATION_PUBLIC_PAGE_STYLES`).
--     The parity integration test in
--     `packages/api/src/tests/integration/feature-flags.test.ts`
--     asserts label + description + scope + tenant_override_allowed +
--     public match between this row and the registry. Drift fails CI.
--   - `docs/adrs/adr-030-public-page-style-archetypes.md` — hybrid
--     shell + slot architecture.
--   - `docs/ideas/public-page-styles-teardown.md` — competitive
--     teardown + archetype shortlist.
--
-- Posture:
--   * `enabled = FALSE` — every tenant ships with the flag off, so
--     the donor-facing `/p/[id]` page renders today's hardcoded layout
--     until super-admin flips the per-tenant override on. No big-bang
--     visual change for existing tenants.
--   * `scope = 'tenant'` — every NPO is independent; one tenant on
--     `cosmic-gradient` doesn't force every other tenant to be too.
--     This is the same posture as `communication.bulk_email` (post-
--     migration 0052) — the kill-switch is per-tenant rather than
--     platform-wide.
--   * `tenant_override_allowed = FALSE` for the initial rollout —
--     super-admin retains the gate until the picker UX is proven
--     in production. Flips to TRUE in a follow-up once org-admins can
--     self-serve safely (no policy reason to keep them out beyond
--     "let's see how the picker lands first").
--   * `public = TRUE` — the settings layout + the campaign editor
--     SSR-fetch `/v1/feature-flags` to decide whether to render the
--     "Page style" picker. A private value here would unconditionally
--     hide the entry and defeat the Epic. The flag name is intentionally
--     descriptive (`donation.public_page_styles`) so the public-
--     projection caveat from `docs/18-feature-flags.md` §0 doesn't
--     tease an unannounced surprise.
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
  'donation.public_page_styles',
  FALSE,
  'Visual style picker for the public donation page',
  'Lets your organisation pick from several visual styles for the public donation page that donors see — from a restrained institutional layout to bold activist designs. Off by default: existing campaigns keep their current look until you choose a different style from the Settings menu. Givernance staff turn this on for your organisation after a brief walk-through of the picker.',
  'tenant',
  FALSE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;
