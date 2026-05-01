-- Migration: 0033_impersonation_sessions
-- Issue #24 — RFC 8693 delegation + pure impersonation, two coexisting modes.
--
-- Adds:
--   1. `impersonation_mode` and `impersonation_end_reason` enums.
--   2. `impersonation_sessions` platform-level table (no RLS — super-admin
--      reads cross-tenant; queries always go through the system pool).
--   3. Two nullable columns on `audit_logs` so every action performed inside
--      a session is double-attributed AND mode-discriminated:
--        - `impersonation_session_id` — FK to impersonation_sessions.id
--        - `impersonation_mode`        — denormalised mode for SIEM filtering
--   4. Append-only trigger on `impersonation_sessions` — only the `ended_at`,
--      `end_reason` columns may transition from NULL to a value.
--
-- Idempotent (matches the project convention; see 0032_user_soft_delete.sql).

DO $$ BEGIN
  CREATE TYPE impersonation_mode AS ENUM ('delegation', 'impersonation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE impersonation_end_reason AS ENUM ('manual', 'expired', 'revoked', 'switched');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id                          UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  impersonator_keycloak_id    VARCHAR(255)            NOT NULL,
  target_keycloak_id          VARCHAR(255)            NOT NULL,
  target_org_id               UUID                    NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_role                 VARCHAR(50)             NOT NULL,
  mode                        impersonation_mode      NOT NULL,
  reason                      TEXT                    NOT NULL,
  expires_at                  TIMESTAMPTZ             NOT NULL,
  ended_at                    TIMESTAMPTZ,
  end_reason                  impersonation_end_reason,
  ip_hash                     VARCHAR(64),
  user_agent                  TEXT,
  created_at                  TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  CONSTRAINT impersonation_sessions_reason_min_length CHECK (length(reason) >= 20),
  CONSTRAINT impersonation_sessions_expires_after_creation CHECK (expires_at > created_at),
  -- end_reason can only be set together with ended_at; expiry path leaves
  -- both NULL and is computed from `expires_at <= now()` at read time.
  CONSTRAINT impersonation_sessions_end_consistency CHECK (
    (ended_at IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS imp_sessions_impersonator_idx
  ON impersonation_sessions (impersonator_keycloak_id);
CREATE INDEX IF NOT EXISTS imp_sessions_target_user_idx
  ON impersonation_sessions (target_keycloak_id);
CREATE INDEX IF NOT EXISTS imp_sessions_target_org_idx
  ON impersonation_sessions (target_org_id);
CREATE INDEX IF NOT EXISTS imp_sessions_expires_at_idx
  ON impersonation_sessions (expires_at);
CREATE INDEX IF NOT EXISTS imp_sessions_mode_idx
  ON impersonation_sessions (mode);

-- Append-only enforcement: once a session is created, the only legal
-- mutation is the one-time NULL→value transition on (ended_at, end_reason).
-- All other UPDATEs and any DELETE are rejected. This mirrors the
-- audit_logs immutability trigger (0004_schema_hardening.sql) and keeps
-- the GDPR Art. 5(2) accountability story coherent.
CREATE OR REPLACE FUNCTION prevent_impersonation_session_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'impersonation_sessions table is append-only — DELETE is not permitted';
  END IF;

  IF OLD.id                          IS DISTINCT FROM NEW.id
     OR OLD.impersonator_keycloak_id IS DISTINCT FROM NEW.impersonator_keycloak_id
     OR OLD.target_keycloak_id       IS DISTINCT FROM NEW.target_keycloak_id
     OR OLD.target_org_id            IS DISTINCT FROM NEW.target_org_id
     OR OLD.target_role              IS DISTINCT FROM NEW.target_role
     OR OLD.mode                     IS DISTINCT FROM NEW.mode
     OR OLD.reason                   IS DISTINCT FROM NEW.reason
     OR OLD.expires_at               IS DISTINCT FROM NEW.expires_at
     OR OLD.ip_hash                  IS DISTINCT FROM NEW.ip_hash
     OR OLD.user_agent               IS DISTINCT FROM NEW.user_agent
     OR OLD.created_at               IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'impersonation_sessions: only ended_at and end_reason may be updated';
  END IF;

  -- Set-once semantics on the (ended_at, end_reason) pair. Reviewer H3:
  --   * once a row is ended, neither column may change again
  --   * a transition that touches the pair MUST set both to non-NULL —
  --     no partial updates (e.g. SET end_reason = 'expired' without
  --     ended_at), no NULL→NULL noop that masks intent
  IF OLD.ended_at IS NOT NULL THEN
    IF OLD.ended_at   IS DISTINCT FROM NEW.ended_at
       OR OLD.end_reason IS DISTINCT FROM NEW.end_reason THEN
      RAISE EXCEPTION 'impersonation_sessions: ended_at and end_reason are set-once';
    END IF;
  ELSE
    -- OLD.ended_at IS NULL — only legal transition is to non-NULL on BOTH columns.
    IF OLD.ended_at IS DISTINCT FROM NEW.ended_at OR OLD.end_reason IS DISTINCT FROM NEW.end_reason THEN
      IF NEW.ended_at IS NULL OR NEW.end_reason IS NULL THEN
        RAISE EXCEPTION 'impersonation_sessions: ended_at AND end_reason must transition together to non-NULL values';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS impersonation_sessions_append_only ON impersonation_sessions;
CREATE TRIGGER impersonation_sessions_append_only
  BEFORE UPDATE OR DELETE ON impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_impersonation_session_mutation();

-- Audit log additions. New columns are nullable so existing rows retain
-- their meaning — `impersonation_session_id IS NULL` ⇒ normal traffic.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS impersonation_session_id UUID
    REFERENCES impersonation_sessions(id) ON DELETE RESTRICT;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS impersonation_mode VARCHAR(32);

-- Reviewer M3: lock down `audit_logs.impersonation_mode` to the same
-- domain values as the typed enum on `impersonation_sessions.mode`. Free
-- text VARCHAR risks "impersonated"/typos drifting in via future code.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_impersonation_mode_chk'
  ) THEN
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_impersonation_mode_chk
      CHECK (impersonation_mode IS NULL OR impersonation_mode IN ('delegation', 'impersonation'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audit_logs_imp_session_idx
  ON audit_logs (impersonation_session_id);

-- Reviewer H4: belt-and-suspenders RLS on impersonation_sessions. The app
-- pool runs as `givernance_app` (NOBYPASSRLS); without this REVOKE, an
-- accidental query through `db` (instead of `systemDb`) from a future
-- non-super-admin code path would silently return cross-tenant rows. The
-- super-admin admin endpoints stay on `systemDb` (BYPASSRLS), so they're
-- unaffected.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'givernance_app') THEN
    EXECUTE 'REVOKE ALL ON impersonation_sessions FROM givernance_app';
  END IF;
END $$;
