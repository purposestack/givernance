-- Issue #430 — tenant-isolation hardening.
--
-- Three structural gaps surfaced by the 2026-05-23 cross-tenant leak audit:
--
--   1. `tenant_disputes` was created in migration 0031 with an `org_id`
--      column but no RLS attached (no ENABLE, no FORCE, no policy). The
--      table holds donor-facing claimer PII (email + first/last name +
--      free-text reason). Add ENABLE + FORCE + `tenant_isolation` policy
--      matching every other tenant-scoped table.
--
--   2. `receipt_sequences` was created in migration 0011 with an `org_id`
--      column but was never picked up by the `0012_force_rls.sql`
--      roll-up. Same treatment.
--
--   3. `givernance_app` was created in 0005 with the default `NOBYPASSRLS`
--      attribute (no explicit keyword). A future `ALTER ROLE givernance_app
--      BYPASSRLS` by an operator would silently disable the safety net.
--      Make `NOBYPASSRLS` explicit + idempotent.
--
-- Reviewed in PR #<linked-to-issue-430>. Co-ships with the application-
-- code defence-in-depth filters (every tenant query carries an explicit
-- `eq(org_id, …)` predicate) and the boot-time `rolbypassrls` guard in
-- `assertAppRoleSecure` / `assertWorkerAppRoleSecure`.

-- 1. tenant_disputes -----------------------------------------------------

ALTER TABLE "tenant_disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_disputes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "tenant_disputes"
  FOR ALL
  USING ("org_id" = app_current_organization_id())
  WITH CHECK ("org_id" = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_disputes" TO "givernance_app";

-- 2. receipt_sequences ---------------------------------------------------

ALTER TABLE "receipt_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_sequences" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "receipt_sequences"
  FOR ALL
  USING ("org_id" = app_current_organization_id())
  WITH CHECK ("org_id" = app_current_organization_id());

-- 3. givernance_app role hardening --------------------------------------
--
-- `ALTER ROLE … NOBYPASSRLS` is idempotent and safe to re-run. Belt-and-
-- suspenders: even though `CREATE ROLE` defaults to NOBYPASSRLS, making
-- the attribute explicit means a future operator audit ("does this role
-- bypass RLS?") gets a clear answer from `pg_roles.rolbypassrls`.

ALTER ROLE "givernance_app" NOBYPASSRLS;
