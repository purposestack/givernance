-- Migration: 0028_invitation_locale
-- Issue #153 follow-up: per-invitation locale.
--
-- Lets the inviting org_admin pre-pick the language for each invitee,
-- so a multi-language onboarding (FR + EN board members imported from a
-- CSV, for example) sends each their welcome email in the right
-- language *and* pre-seeds the accept form's locale picker. NULL means
-- "no admin override" — the email + accept form fall back to the
-- tenant's `default_locale`.
--
-- Resolution chain at email-enqueue time becomes:
--
--   users.locale ?? invitations.locale ?? tenants.default_locale ?? APP_DEFAULT_LOCALE
--
-- The personal user override always wins on a re-invite — the admin's
-- choice on the new invitation row never overrides what the user
-- picked themselves.

ALTER TABLE "invitations" ADD COLUMN "locale" varchar(10);--> statement-breakpoint

-- Supported-locale guard. Mirror of `SUPPORTED_LOCALES` in
-- `packages/shared/src/i18n/locales.ts`. Keep all three CHECK
-- constraints (tenants, users, invitations) in lockstep with the
-- TS constant when adding a Phase-3+ locale.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_locale_chk"
  CHECK ("locale" IS NULL OR "locale" IN ('en', 'fr'));
