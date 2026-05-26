-- Migration: 0080_platform_admins_locale
--
-- The `/v1/users/me` profile page lets every authenticated user pick
-- their UI language (FR / EN). For tenant users this stores into
-- `users.locale`; super-admins go through `platform_admins` (ADR-022,
-- disjoint identity surface) and that table never had a `locale`
-- column — so `PATCH /v1/users/me` 404'd for super-admins, blocking
-- the profile page entirely for that role.
--
-- This adds the missing column. NULL means "inherit the browser /
-- platform default" — same semantics as `users.locale = NULL`.
-- The CHECK constraint mirrors the tenant-side enum so the two
-- surfaces stay in lockstep.

ALTER TABLE platform_admins
  ADD COLUMN IF NOT EXISTS locale TEXT;

ALTER TABLE platform_admins
  DROP CONSTRAINT IF EXISTS platform_admins_locale_chk;
ALTER TABLE platform_admins
  ADD CONSTRAINT platform_admins_locale_chk
  CHECK (locale IS NULL OR locale IN ('en', 'fr'));
