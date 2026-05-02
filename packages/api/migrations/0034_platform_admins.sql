-- Migration: 0034_platform_admins
-- ADR-022: Platform Admins disjoint from tenant users.
--
-- Creates the `platform_admins` table that holds Givernance staff records.
-- A platform admin is a Keycloak principal with the `super_admin` realm role;
-- they are NOT tenant members and never appear in the `users` table. This
-- replaces the `PLATFORM_TENANT_ID` sentinel previously used by the
-- impersonation guard with a first-class table the audit story can query
-- directly.
--
-- Soft-delete only (universal Givernance rule, ADR-021): a removed
-- super-admin's row is preserved with `deleted_at IS NOT NULL` so the audit
-- trail of who has had platform access stays intact even after offboarding.
--
-- No RLS: the table is platform-level by definition. All reads/writes go
-- through the BYPASSRLS owner pool (`systemDb`). The defensive REVOKE on
-- the app role mirrors the impersonation_sessions pattern from
-- 0033_impersonation_sessions.sql — a future code path that accidentally
-- queries through `db` (NOBYPASSRLS) gets a hard error instead of an
-- empty result set.
--
-- Idempotent (matches 0032/0033 conventions).

CREATE TABLE IF NOT EXISTS platform_admins (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_id     VARCHAR(255),
  email           VARCHAR(255) NOT NULL,
  first_name      VARCHAR(255) NOT NULL,
  last_name       VARCHAR(255) NOT NULL,
  last_login_at   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Partial unique on keycloak_id (active rows only) — mirrors the users
-- pattern from 0032_user_soft_delete.sql so a soft-deleted super-admin's
-- Keycloak id can be re-bound after offboarding without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_keycloak_id_active_uniq
  ON platform_admins (keycloak_id)
  WHERE deleted_at IS NULL AND keycloak_id IS NOT NULL;

-- Partial unique on lower(email) — same active-only pattern; case-folded so
-- "Admin@…" and "admin@…" don't both slip through.
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_email_active_uniq
  ON platform_admins (lower(email))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS platform_admins_deleted_at_idx
  ON platform_admins (deleted_at);

-- Defensive REVOKE: the app pool is NOBYPASSRLS but `platform_admins` has no
-- RLS policy. Without REVOKE, an accidental `db.select().from(platformAdmins)`
-- through the app pool would return all rows. Forcing every read through
-- `systemDb` is the architectural invariant; a 42501 error here is the
-- desired failure mode if that invariant is violated in code.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'givernance_app') THEN
    EXECUTE 'REVOKE ALL ON platform_admins FROM givernance_app';
  END IF;
END $$;
