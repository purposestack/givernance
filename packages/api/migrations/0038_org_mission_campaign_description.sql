-- Migration: 0038_org_mission_campaign_description
-- Epic #274 follow-up — postal letter content enrichment.
--
-- Two new free-form text fields surface in the postal letter PDFs:
--   - `tenants.mission`  — what the organisation does, drives the
--     letter's contextual paragraph and the donation page footer.
--   - `campaigns.description` — admin-side description of the
--     campaign, distinct from `campaign_public_pages.description`
--     (which is the donor-facing copy). The admin description seeds
--     the public page on first publish and feeds the postal letter.
--
-- Both columns are TEXT (no length cap at the DB layer; the validator
-- soft-caps at 2000 chars) and nullable so existing rows remain valid.
-- Idempotent — uses `IF NOT EXISTS` so re-runs on a fresh checkout
-- after a `db:migrate` are no-ops.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS mission TEXT;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS description TEXT;
