-- Migration: 0054_public_page_style_columns (Epic #362, Phase 1)
--
-- Two columns + a Postgres enum. Resolution at read time is:
--     campaigns.public_page_style ?? tenants.default_public_page_style ?? 'foundation'
--
-- Both columns nullable, no backfill, no DEFAULT. Rationale: NULL
-- distinguishes "operator hasn't picked" from "operator picked
-- Foundation" — the picker shows the inheritance breadcrumb on the
-- former. A `NOT NULL DEFAULT 'foundation'` would defeat the soft
-- rollout by silently stamping every legacy campaign.
--
-- Idempotent. Enum kept in lockstep with `PUBLIC_PAGE_STYLE_KEYS` in
-- `packages/shared/src/constants/public-page-styles.ts`; the
-- integration test asserts parity. Flag-gating lives on the routes
-- (`donation.public_page_styles`), not the schema.

-- ─── 1. The enum ────────────────────────────────────────────────────────────
-- Order matches PUBLIC_PAGE_STYLE_KEYS — operator-facing picker tile
-- order. Don't sort alphabetically.

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

-- No index on either column — low cardinality, read path already
-- filters on primary keys before reading the style.
