-- Migration: 0020_tenant_onboarding
-- Adds columns to tenants for the self-serve onboarding wizard shipped in
-- #40 PR-A4. Phase 1 captures core organisation profile (country, legal type,
-- currency, registration number) + a completion timestamp used by the web
-- app to gate protected routes until onboarding is done.
--
-- Logo storage and GDPR/team/import columns are deferred to #78 (Phase 2).

ALTER TABLE tenants
  ADD COLUMN country varchar(2),
  ADD COLUMN legal_type varchar(50),
  ADD COLUMN currency varchar(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN registration_number varchar(100),
  ADD COLUMN logo_url varchar(500),
  ADD COLUMN onboarding_completed_at timestamp with time zone;
