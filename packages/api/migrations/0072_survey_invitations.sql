-- Migration: 0072_survey_invitations (Epic #434, issue #435; docs/32)
--
-- One row per (survey, recipient, send). `user_id` is the canonical
-- recipient when channel='in_app'; for channel='email' the row may
-- carry `user_id` (when we send to a known org user) or NULL (when
-- the survey is sent to an external address like a tenant's billing
-- email — out of scope for MVP but the column shape allows it).
--
-- TENANT-SCOPED. RLS enabled + FORCED on `org_id`. Per CLAUDE.md
-- "RLS is the safety net, never the contract" — every API/worker
-- query MUST also carry `eq(surveyInvitations.orgId, ctx.orgId)`.
--
-- FK cascade rules:
--   * `survey_id` ON DELETE CASCADE — retiring a survey def takes its
--     invitations with it (the responses table cascades from here).
--   * `org_id` ON DELETE CASCADE — tenant deletion is total per ADR-021
--     erasure cascade.
--   * `user_id` ON DELETE SET NULL — GDPR erasure of a user nulls the
--     pointer but preserves the row for the per-tenant response count
--     (privacy posture: keep the aggregate, drop the identity).
--     Security-architect re-review BLOCKING item from epic #434.
--
-- Indexes:
--   * `(survey_id, org_id)` — per-survey per-tenant lookups (the
--     dashboard's "responseCount / invitedCount" per tenant).
--   * `(user_id) WHERE user_id IS NOT NULL` — partial: most invitations
--     have a non-NULL user_id; the planner uses this for the
--     "what surveys is this user pending?" in-app modal query.
--   * `(expires_at) WHERE opened_at IS NULL` — partial: the survey
--     worker scans this nightly to garbage-collect expired-unopened
--     invitations.
--
-- Soft-delete with `deleted_at` (ADR-021). No unique constraint on the
-- table — the natural "one survey per recipient per cadence" guard
-- lives in the worker (idempotency-key dedupe via the
-- `survey_launches` table in migration 0074).

CREATE TABLE survey_invitations (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id     UUID         NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  user_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
  org_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       TEXT         NOT NULL,
  invited_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reminded_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ  NOT NULL,
  opened_at     TIMESTAMPTZ,
  dismissed_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,

  CONSTRAINT survey_invitations_channel_chk
    CHECK (channel IN ('email', 'in_app'))
);

CREATE INDEX survey_invitations_survey_org_idx
  ON survey_invitations (survey_id, org_id);

CREATE INDEX survey_invitations_user_idx
  ON survey_invitations (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX survey_invitations_expiry_sweep_idx
  ON survey_invitations (expires_at)
  WHERE opened_at IS NULL;

ALTER TABLE survey_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON survey_invitations
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON survey_invitations TO givernance_app;
