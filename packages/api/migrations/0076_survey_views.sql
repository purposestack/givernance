-- Migration: 0076_survey_views (Epic #434, issue #439; docs/32)
--
-- Two read-side views over `survey_responses` + `survey_invitations` that
-- encode the two non-negotiable GDPR / privacy invariants of the survey
-- subsystem at the DATABASE layer — so a buggy frontend or a sloppy
-- TypeBox shape cannot leak data the operator product never agreed to
-- expose.
--
-- 1. `survey_responses_reviewed`  — DPO-review gate on free-text
--    ---------------------------------------------------------------
--    Every survey may include a free-text follow-up (PMF "why_text",
--    NPS "comment", CSAT "comment"). Free-text is open-ended PII and
--    must NOT surface in the super-admin dashboard until the DPO has
--    reviewed and cleared the row (epic #434 security-architect
--    BLOCKING). The gate is enforced at TWO layers:
--      * THIS view — `response_text` is NULL whenever
--        `text_reviewed_at IS NULL`.
--      * API TypeBox shape (#437) — `response_text` is absent from
--        any projection that hasn't been reviewed.
--    The two-layer design means a buggy frontend cannot leak
--    unreviewed text — even a hand-crafted SQL query through the
--    `givernance_app` role observes the NULL.
--
-- 2. `survey_responses_aggregate` — k-anonymity gate on per-tenant
--    breakdowns
--    ---------------------------------------------------------------
--    Per-tenant survey aggregates (PMF %, NPS score, CSAT avg) are
--    suppressed when `response_count < 5`. Below the k-anonymity
--    threshold a single response can re-identify the answerer (in a
--    2-person tenant a 0/0/1 split tells you exactly who said what).
--    The dashboard renders "—" + a "n<5" badge for suppressed rows;
--    the view enforces the suppression at the SQL boundary so a
--    bypass on the dashboard never sees the underlying number.
--
-- Both views project FROM the soft-delete-filtered base (`deleted_at
-- IS NULL`) so the standard ADR-021 row-visibility rule applies
-- uniformly through the read path.
--
-- Permissions:
--   * `survey_responses_reviewed` — GRANT SELECT to `givernance_app`.
--     The tenant-scoped operator UI (when org-admins eventually see
--     their own verbatims, post-MVP) consumes this view. RLS on the
--     underlying `survey_responses` table still applies via the
--     view's `security_invoker = true` (Postgres 15+ default for
--     views).
--   * `survey_responses_aggregate` — REVOKE ALL from `givernance_app`.
--     Per-tenant aggregates are super-admin material; the API reads
--     this view through `systemDb` only. Keeping the tenant pool out
--     means an accidental query through a tenant connection fails
--     loud (`permission denied for view`) rather than silently
--     returning data scoped to one org.

-- ─── 1. DPO-review-gated read of survey_responses ─────────────────
CREATE OR REPLACE VIEW survey_responses_reviewed
WITH (security_invoker = true) AS
SELECT
  id,
  invitation_id,
  org_id,
  -- Numeric / structured response data is ALWAYS exposed — these are
  -- the bounded-cardinality fields (PMF category enum, NPS 0..10,
  -- CSAT 1..5) that drive the KPIs. No PII risk.
  jsonb_strip_nulls(
    jsonb_build_object(
      'score', response -> 'score',
      'category', response -> 'category',
      'rating', response -> 'rating'
    )
  ) AS response_structured,
  -- Free-text fields — surfaced ONLY when the DPO has reviewed the row.
  CASE
    WHEN text_reviewed_at IS NOT NULL THEN response ->> 'text'
    ELSE NULL
  END AS response_text,
  CASE
    WHEN text_reviewed_at IS NOT NULL THEN response ->> 'why_text'
    ELSE NULL
  END AS response_why_text,
  CASE
    WHEN text_reviewed_at IS NOT NULL THEN response ->> 'comment'
    ELSE NULL
  END AS response_comment,
  submitted_at,
  text_reviewed_at,
  reviewed_by,
  deleted_at
FROM survey_responses
WHERE deleted_at IS NULL;

GRANT SELECT ON survey_responses_reviewed TO givernance_app;

-- ─── 2. k-anonymity-gated per-tenant aggregates ───────────────────
-- The HAVING clause enforces the k>=5 threshold: tenants with fewer
-- than 5 responses for a given survey are entirely absent from the
-- view, so the dashboard's "—" + "n<5" rendering is the only path
-- through which the suppressed-state is visible.
CREATE OR REPLACE VIEW survey_responses_aggregate AS
SELECT
  i.survey_id,
  i.org_id,
  s.kind,
  COUNT(r.id) AS response_count,
  -- PMF: % of respondents who would be "very disappointed" if the
  -- product went away (Sean Ellis ≥ 40% = PMF achieved).
  CASE
    WHEN s.kind = 'pmf' THEN
      100.0
      * COUNT(*) FILTER (WHERE r.response ->> 'category' = 'very_disappointed')
      / NULLIF(COUNT(r.id), 0)
  END AS pmf_percent,
  -- NPS: %promoters (score >= 9) minus %detractors (score <= 6).
  CASE
    WHEN s.kind = 'nps' THEN
      (
        100.0 * COUNT(*) FILTER (WHERE (r.response ->> 'score')::int >= 9)
        - 100.0 * COUNT(*) FILTER (WHERE (r.response ->> 'score')::int <= 6)
      )
      / NULLIF(COUNT(r.id), 0)
  END AS nps_score,
  -- CSAT: arithmetic mean of the 1..5 rating.
  CASE
    WHEN s.kind = 'csat' THEN AVG((r.response ->> 'rating')::numeric)
  END AS csat_score,
  MAX(r.submitted_at) AS last_collected_at
FROM survey_invitations i
JOIN surveys s
  ON s.id = i.survey_id
LEFT JOIN survey_responses r
  ON r.invitation_id = i.id
  AND r.deleted_at IS NULL
WHERE i.deleted_at IS NULL
GROUP BY i.survey_id, i.org_id, s.kind
HAVING COUNT(r.id) >= 5;  -- k-anonymity gate

-- Aggregates are super-admin-only; lock the tenant pool out so a
-- mistaken tenant-scope query fails loud.
REVOKE ALL ON survey_responses_aggregate FROM givernance_app;
