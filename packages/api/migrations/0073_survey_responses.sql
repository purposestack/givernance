-- Migration: 0073_survey_responses (Epic #434, issue #435; docs/32)
--
-- One row per submitted survey response. UNIQUE on `invitation_id`
-- enforces the "one response per invitation" invariant — re-submits
-- are upserts against the same row, not new rows.
--
-- `org_id` is DENORMALISED from `survey_invitations.org_id` so the RLS
-- policy can run without a join. The dashboard's per-tenant
-- aggregation query (`COUNT(*) GROUP BY org_id`) also benefits from
-- locality — no join hop. The denormalisation is safe because
-- `org_id` is immutable on the invitation (tenant transfer of an
-- invitation is not a supported operation; tenant deletion cascades
-- both rows).
--
-- TENANT-SCOPED. RLS enabled + FORCED on `org_id` — same defence
-- pattern as `survey_invitations` (0072). API code MUST still carry
-- `eq(surveyResponses.orgId, ctx.orgId)` explicitly.
--
-- `response` JSONB carries the survey-kind-specific payload:
--   * PMF: {"category": "very_disappointed" | "somewhat" | "not", "why_text": "…"}
--   * NPS: {"score": 0..10, "comment": "…"}
--   * CSAT: {"rating": 1..5, "comment": "…"}
-- Per security-architect re-review, write-time TypeBox validation +
-- DOMPurify on free-text fields lives in the API layer (#437) —
-- the column itself is intentionally schemaless to keep custom
-- surveys flexible.
--
-- DPO review fields (`text_reviewed_at` + `reviewed_by`): every free-
-- text response must be DPO-reviewed before it appears in the per-
-- tenant verbatim list (epic-level GDPR posture). The dashboard's
-- "verbatims" tile filters `WHERE text_reviewed_at IS NOT NULL` so
-- un-reviewed PII never reaches a super-admin who isn't the DPO.
-- `reviewed_by` points at `platform_admins.id` with `ON DELETE SET
-- NULL` so an offboarded DPO doesn't FK-block historical reviews.
--
-- FK cascade rules:
--   * `invitation_id` ON DELETE CASCADE — purging an invitation
--     (org delete, survey retirement) takes its response too.
--   * `org_id` ON DELETE CASCADE — tenant deletion is total.
--   * `reviewed_by` ON DELETE SET NULL — see DPO review note above.
--
-- Soft-delete `deleted_at` (ADR-021). Index on `(submitted_at)` for
-- the retention worker (24-month sweep — docs/32).

CREATE TABLE survey_responses (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id     UUID         NOT NULL REFERENCES survey_invitations(id) ON DELETE CASCADE,
  org_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  response          JSONB        NOT NULL,
  submitted_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  text_reviewed_at  TIMESTAMPTZ,
  reviewed_by       UUID         REFERENCES platform_admins(id) ON DELETE SET NULL,
  deleted_at        TIMESTAMPTZ
);

-- One response per invitation. Partial on `deleted_at IS NULL` so a
-- soft-deleted response (rare — DPO-triggered erasure) doesn't block
-- a re-submission against the same invitation. ADR-021 + schema-
-- parity test guard.
CREATE UNIQUE INDEX survey_responses_invitation_uniq
  ON survey_responses (invitation_id)
  WHERE deleted_at IS NULL;

CREATE INDEX survey_responses_submitted_at_idx
  ON survey_responses (submitted_at);

ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON survey_responses
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON survey_responses TO givernance_app;
