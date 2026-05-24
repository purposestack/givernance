-- Migration: 0074_survey_launches (Epic #434, issue #435; security-architect
-- BLOCKING item from epic re-review)
--
-- Idempotency-dedup table for the 3 super-admin survey-launch endpoints
-- on the dashboard (`POST /v1/superadmin/surveys/:slug/launch` for
-- channel='email'/'in_app' and `POST /v1/superadmin/surveys/:slug/schedule`).
-- The endpoints accept an `Idempotency-Key` header (UUID); the API
-- inserts into this table with `ON CONFLICT (idempotency_key) DO
-- NOTHING` and treats a conflict as "already processed, replay the
-- previous response".
--
-- Secondary purpose: enforces the 24-hour cooldown per (survey,
-- channel) that the security-architect requires — the API consults
-- `MAX(launched_at) WHERE survey_id=? AND channel=?` before accepting
-- a new launch, so a double-click or accidental re-trigger inside the
-- cooldown window is rejected with 429 (not silently re-sent).
--
-- PLATFORM-LEVEL. No `org_id`, no RLS. Reads/writes go through
-- `systemDb` from the super-admin route handlers only. REVOKE on
-- `givernance_app` so the tenant pool can't touch it.
--
-- `launched_by` is the super-admin who clicked the button — feeds the
-- per-launch audit_log row (security-architect "audit log per survey
-- launch" BLOCKING).
--
-- `recipient_count` records how many invitations the launch produced
-- (denormalised from `survey_invitations` for a fast dashboard
-- "dernier envoi: 38 destinataires" tile without a COUNT scan).

CREATE TABLE survey_launches (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id         UUID         NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  -- 'email' | 'in_app' | 'schedule' — the schedule endpoint also logs
  -- here so the cooldown check is uniform across all 3 routes.
  channel           TEXT         NOT NULL,
  -- UUID supplied by the client in the `Idempotency-Key` header.
  -- UNIQUE — the upsert key for dedup.
  idempotency_key   UUID         NOT NULL UNIQUE,
  launched_by       UUID         NOT NULL REFERENCES platform_admins(id),
  recipient_count   INTEGER      NOT NULL DEFAULT 0,
  launched_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT survey_launches_channel_chk
    CHECK (channel IN ('email', 'in_app', 'schedule'))
);

-- Cooldown lookup: `SELECT 1 FROM survey_launches WHERE survey_id=?
-- AND channel=? ORDER BY launched_at DESC LIMIT 1`. Index supports
-- the 24h-cooldown check on the API hot path.
CREATE INDEX survey_launches_cooldown_idx
  ON survey_launches (survey_id, channel, launched_at DESC);

REVOKE ALL ON survey_launches FROM givernance_app;
