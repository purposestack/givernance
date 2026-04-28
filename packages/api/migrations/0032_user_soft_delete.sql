-- ADR-021: User Lifecycle — soft-delete in app, hard-delete in Keycloak.
--
-- 1. Add `deleted_at` to `users`. Listing endpoints, /me, and PATCH all
--    filter on `deleted_at IS NULL`; the auth plugin's active-row check
--    does the same so a soft-deleted user cannot reach protected routes.
-- 2. Replace the unconditional unique `(org_id, email)` with a PARTIAL
--    unique restricted to active rows. This lets the same email be
--    re-invited after soft-delete: the soft-deleted row sits outside
--    the index, so an INSERT (or upsert restoration) doesn't conflict.
--
-- This file is **idempotent**. The dev workflow occasionally applies
-- migrations out-of-band (manual psql for hot patching); using
-- `IF NOT EXISTS` / `IF EXISTS` keeps `pnpm db:migrate` re-runnable
-- against any combination of "already applied" / "fresh" databases.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_org_id_email_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "users_org_id_email_active_uniq"
  ON "users" ("org_id", "email")
  WHERE "deleted_at" IS NULL;
