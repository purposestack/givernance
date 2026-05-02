-- Migration: 0035_invitation_purpose_platform_admin
-- Issue #254 fix-commit 4 — admit `platform_admin_invite` as a valid
-- `invitations.purpose` so the platform-admin invitation flow can write
-- to the shared `invitations` table.
--
-- Idempotent: drops the prior check constraint (0022) and re-adds it
-- with the widened set of allowed values. Keeps the constraint name
-- stable so the next widening (e.g. another invitation purpose) follows
-- the same DROP/ADD pattern.

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_purpose_chk;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_purpose_chk
  CHECK (purpose IN ('team_invite', 'signup_verification', 'platform_admin_invite'));
