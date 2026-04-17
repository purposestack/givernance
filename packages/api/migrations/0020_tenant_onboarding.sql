-- Migration: 0020_tenant_onboarding
-- Adds columns to tenants for the self-serve onboarding wizard shipped in
-- #40 PR-A4. Phase 1 captures core organisation profile (country, legal type,
-- currency, registration number) + a completion timestamp used by the web
-- app to gate protected routes until onboarding is done.
--
-- Also enforces uniqueness on users.keycloak_id so the onboarding bootstrap
-- path cannot race-create two tenants for the same Keycloak subject (concurrent
-- double-click / retry storm).
--
-- Logo storage and GDPR/team/import columns are deferred to #78 (Phase 2).

ALTER TABLE tenants
  ADD COLUMN country varchar(2),
  ADD COLUMN legal_type varchar(50),
  ADD COLUMN currency varchar(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN registration_number varchar(100),
  ADD COLUMN logo_url varchar(500),
  ADD COLUMN onboarding_completed_at timestamp with time zone;

-- Partial UNIQUE so legacy rows with a null keycloak_id (pre-SSO users) don't
-- collide. New rows written by the onboarding bootstrap always carry a
-- Keycloak sub and will be guarded by this index.
CREATE UNIQUE INDEX users_keycloak_id_uniq
  ON users (keycloak_id)
  WHERE keycloak_id IS NOT NULL;
