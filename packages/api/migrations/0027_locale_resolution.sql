-- Migration: 0027_locale_resolution
-- Issue #153: 3-layer locale resolution model.
--
-- Adds first-class country + locale columns so the worker no longer infers
-- email language from a `tenant.signup_verification_requested` outbox event
-- payload (which doesn't exist for enterprise-seeded tenants and is fragile
-- to outbox retention/archival).
--
-- New columns:
--   tenants.country         varchar(2)  NULL          ISO-3166-1 alpha-2
--   tenants.default_locale  varchar(10) NOT NULL='fr' BCP-47 (ADR-015)
--   users.locale            varchar(10) NULL          BCP-47 personal override
--
-- Resolution chain (effective_locale at email enqueue time):
--   user.locale ?? tenant.default_locale ?? APP_DEFAULT_LOCALE ('fr')
--
-- See `packages/shared/src/i18n/locales.ts` for the SUPPORTED_LOCALES
-- constant — keep the CHECK constraint values below in lockstep.

-- ─── 1. Add columns ────────────────────────────────────────────────────────
ALTER TABLE "tenants" ADD COLUMN "country" varchar(2);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_locale" varchar(10) DEFAULT 'fr' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" varchar(10);--> statement-breakpoint

-- ─── 2. Backfill tenants.country from outbox payload ───────────────────────
-- Self-serve tenants emitted `country` on the original
-- `tenant.signup_verification_requested` event. Pick the latest payload's
-- country (most recent resend wins, since resend re-emits the original
-- country) and copy it onto the row. Enterprise-seeded tenants have no such
-- event; their country stays NULL until an org_admin sets it via the
-- /v1/tenants/me PATCH (issue #153 follow-up).
DO $$
DECLARE
  populated_country INTEGER;
BEGIN
  WITH latest_signup_event AS (
    SELECT DISTINCT ON (oe.tenant_id)
      oe.tenant_id,
      oe.payload->>'country' AS country
    FROM "outbox_events" oe
    WHERE oe.type IN (
        'tenant.signup_verification_requested',
        'tenant.signup_verification_resent'
      )
      AND oe.payload ? 'country'
      AND jsonb_typeof(oe.payload->'country') = 'string'
    ORDER BY oe.tenant_id, oe.created_at DESC
  )
  UPDATE "tenants" t
    SET "country" = upper(lse.country)
    FROM latest_signup_event lse
    WHERE t."id" = lse.tenant_id
      AND lse.country ~ '^[A-Za-z]{2}$';
  GET DIAGNOSTICS populated_country = ROW_COUNT;
  IF populated_country > 0 THEN
    RAISE NOTICE 'Issue #153: backfilled tenants.country for % rows from outbox payloads', populated_country;
  END IF;
END
$$;
--> statement-breakpoint

-- ─── 3. Backfill tenants.default_locale to preserve existing email behaviour ──
-- Today's worker maps `country='FR' → fr template, else en template`. Mirror
-- that exactly during backfill so a self-serve tenant who was getting EN
-- emails (because their signup country was BE / DE / NL) keeps getting EN
-- after this migration. The rule:
--
--   country = 'FR'                 → 'fr'
--   country IS NOT NULL, != 'FR'   → 'en'   (preserves prior EN fallback)
--   country IS NULL                → 'fr'   (column DEFAULT — fixes the bug
--                                            where enterprise-seeded tenants
--                                            were getting EN by accident)
--
-- Tenants whose country we just populated above need an explicit UPDATE
-- because the column DEFAULT only applied at column-add time when country
-- was still NULL. Tenants we couldn't backfill (no signup event) keep the
-- 'fr' default per the table above.
UPDATE "tenants"
  SET "default_locale" = CASE
    WHEN upper("country") = 'FR' THEN 'fr'
    ELSE 'en'
  END
  WHERE "country" IS NOT NULL;
--> statement-breakpoint

-- ─── 4. CHECK constraints ──────────────────────────────────────────────────
-- ISO-3166-1 alpha-2 shape guard. Defence in depth on top of the API
-- validator — any future code path that bypasses the route schema (a worker
-- backfill, a one-shot script) still cannot insert garbage.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_country_alpha2_chk"
  CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');
--> statement-breakpoint

-- Supported-locale guard for tenants. Mirror of `SUPPORTED_LOCALES` in
-- `packages/shared/src/i18n/locales.ts`. Expand both sides together when a
-- new locale ships.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_default_locale_chk"
  CHECK ("default_locale" IN ('en', 'fr'));
--> statement-breakpoint

-- Same guard for users. NULL is allowed — the resolution chain reads NULL
-- as "follow my tenant's default".
ALTER TABLE "users"
  ADD CONSTRAINT "users_locale_chk"
  CHECK ("locale" IS NULL OR "locale" IN ('en', 'fr'));
