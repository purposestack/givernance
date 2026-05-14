-- Migration: 0054_public_page_style_columns (Epic #362, Phase 1)
--
-- Adds two columns that together implement the picker semantics:
--
--   1. `tenants.default_public_page_style` — org-level default the
--      campaign editor inherits from on first publish. Nullable: NULL
--      means "fall back to the platform-wide hardcoded default
--      (Foundation)". `org_admin` writes it from /settings (PR-3).
--
--   2. `campaigns.public_page_style` — per-campaign override. Nullable:
--      NULL means "inherit from the tenant default". Campaign owners
--      write it from the campaign editor (PR-3). This is the value the
--      donor-facing API actually reads after the three-layer resolution:
--          campaign override ?? tenant default ?? "foundation"
--
-- Both columns use a Postgres enum (`public_page_style`) whose values
-- are kept in lockstep with `PUBLIC_PAGE_STYLE_KEYS` in
-- `packages/shared/src/constants/public-page-styles.ts`. The integration
-- test in `packages/api/src/tests/integration/public-page-styles.test.ts`
-- asserts the enum and the const tuple match — drift fails CI. Same
-- pattern as `campaignTypeEnum` / `campaignStatusEnum` (migration 0003).
--
-- Why nullable + tenant inheritance rather than `NOT NULL DEFAULT
-- 'foundation'`:
--   * `NOT NULL DEFAULT 'foundation'` permanently stamps every existing
--     campaign with "Foundation". That defeats the soft rollout — the
--     operator never "picks" a style, the DB picks one for them, and
--     the picker's "no choice made yet" affordance no longer renders.
--   * `NULL` cleanly distinguishes "operator hasn't decided" from
--     "operator decided on Foundation," which the picker UI needs in
--     order to show the inherits-from-tenant breadcrumb on a campaign
--     that's never been explicitly styled.
--
-- This migration ships even when the `donation.public_page_styles`
-- feature flag is OFF for every tenant — the column existing on the
-- table is structural and per `docs/18-feature-flags.md` § 5 the
-- evaluator gates *reads*, not column existence. The write path
-- (PR-3 and the PUT /v1/campaigns/:id/public-page route in this PR)
-- gates on `requireFlag(...)` as the FIRST preHandler so a scanner
-- with the flag off gets a 404 without enumerating roles.
--
-- Idempotent — `IF NOT EXISTS` on the enum and `ADD COLUMN IF NOT
-- EXISTS` for both columns. No backfill: every existing row picks up
-- NULL (the inheritance default).
--
-- RLS: the columns inherit the existing per-table RLS posture.
-- `campaigns` is tenant-scoped (FORCE ROW LEVEL SECURITY,
-- `org_id = app_current_organization_id()`); `tenants` is owner-only
-- and the `default_public_page_style` write path runs under the
-- `givernance_app` role through the existing PATCH /v1/tenant
-- machinery, which already enforces the org-admin RBAC guard.

-- ─── 1. The enum ────────────────────────────────────────────────────────────
--
-- Order matches `PUBLIC_PAGE_STYLE_KEYS` in the shared constants file
-- (Foundation first as the institutional default, then in voice-
-- quadrant order per the picker UX). Don't sort alphabetically — the
-- order is operator-facing.

DO $$
BEGIN
  CREATE TYPE public_page_style AS ENUM (
    'foundation',
    'activist',
    'editorial-story',
    'minimal-checkout',
    'emergency-appeal',
    'neo-brutalist',
    'calm-wellness',
    'civic-modern',
    'retro-print',
    'cosmic-gradient'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. Column on `tenants` — org-level default ─────────────────────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_public_page_style public_page_style;

COMMENT ON COLUMN tenants.default_public_page_style IS
  'Epic #362 — org-level default visual archetype for new campaigns. NULL = inherit hardcoded ''foundation''.';

-- ─── 3. Column on `campaigns` — per-campaign override ───────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS public_page_style public_page_style;

COMMENT ON COLUMN campaigns.public_page_style IS
  'Epic #362 — per-campaign visual archetype override. NULL = inherit tenant default (or ''foundation'' if that''s also NULL).';

-- No index on either column — neither is a high-cardinality filter
-- column (10 enum values, even distribution at most), and the read
-- path joins on the primary keys / FK indices that already exist.
-- The `/v1/public/campaigns/:id/page` query already filters on
-- `campaign_id` (primary-key) before reading the style column, so the
-- column is just a payload byte on an already-tight scan.
