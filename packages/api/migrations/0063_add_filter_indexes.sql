-- Migration: 0060_add_filter_indexes (issue #422)
--
-- Performance indexes for advanced constituent filtering. These cover
-- the most common filter queries on donations and constituents — the
-- pattern detectors (LYBUNT, SYBUNT, recurring, lapsed, major donor)
-- and the location / tag / type filters in the FilterBuilder UI.
--
-- All indexes are partial / functional where it makes sense to keep
-- them small and selective. ANALYZE at the end refreshes planner
-- statistics so the new indexes start getting picked up immediately
-- in CI / dev runs.

-- Donations by constituent, newest first — backs the "most-recent gift"
-- subquery used by LYBUNT / SYBUNT / RECURRING pattern detectors.
CREATE INDEX IF NOT EXISTS idx_donations_constituent_date
  ON donations(constituent_id, donated_at DESC)
  WHERE status = 'cleared';

-- Donations by amount + date — backs MAJOR_DONOR detector and the
-- "lifetime value ≥ X" filter.
CREATE INDEX IF NOT EXISTS idx_donations_amount_date
  ON donations(amount_base_cents, donated_at)
  WHERE amount_base_cents > 0 AND status = 'cleared';

-- Constituent location triplet — backs the "Geneva region donors" and
-- similar geographic filters.
CREATE INDEX IF NOT EXISTS idx_constituents_location
  ON constituents(city, postal_code, country_code)
  WHERE deleted_at IS NULL;

-- Tag membership (GIN over text[]) — backs the "tags contains X"
-- and "tags overlap [X, Y]" filter operators.
CREATE INDEX IF NOT EXISTS idx_constituents_tags
  ON constituents USING GIN(tags)
  WHERE deleted_at IS NULL;

-- Constituent type per org — backs the donor / volunteer / member
-- segmentation filter.
CREATE INDEX IF NOT EXISTS idx_constituents_type
  ON constituents(type, org_id)
  WHERE deleted_at IS NULL;

-- Email-domain lookup — backs the "organisation detection" filter
-- (e.g. group all donors with `@acme.com` addresses).
CREATE INDEX IF NOT EXISTS idx_constituents_email_domain
  ON constituents(org_id, lower(split_part(email, '@', 2)))
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Campaign membership lookup — backs the "in / not in campaign X"
-- filter.
CREATE INDEX IF NOT EXISTS idx_campaign_constituents_lookup
  ON campaign_constituents(campaign_id, constituent_id);

-- Refresh planner statistics for the tables we just indexed so the new
-- partial / functional indexes start getting picked up immediately.
ANALYZE constituents;
ANALYZE donations;
ANALYZE campaign_constituents;
