/**
 * Test-harness database handle (issue #455).
 *
 * Integration tests run under two roles in CI (job `api-tests-owner` and the
 * must-pass `api-tests-app`). In the `app` job the route-path pool (`db` in
 * `lib/db.ts`) connects as `givernance_app` (NOBYPASSRLS) so any route that
 * forgot `withTenantContext`, or that wrongly used the tenant pool on a
 * REVOKE'd platform table, fails RED instead of silently passing under the
 * BYPASSRLS owner role.
 *
 * Test *harness* code (fixture setup, cross-tenant seeding, and verification
 * reads) is a different thing from the code under test: it legitimately needs
 * to read and write any tenant's rows without an `app.current_organization_id`
 * in scope — that is exactly what the owner role is for. So the harness always
 * uses the OWNER pool, regardless of which role the route-path pool uses.
 *
 * Test files therefore import `db` from THIS module (`../helpers/db.js`), not
 * from `../../lib/db.js`. The `db` exported here is the owner-role handle
 * (`systemDb`). Route code under test is unaffected — it keeps importing the
 * app-role `db` from `lib/db.ts`, which is the pool the `app` job swaps to
 * `givernance_app`. `withTenantContext` is re-exported unchanged: it runs on
 * the route-path pool and sets the GUC, so harness reads that genuinely want
 * to exercise RLS (e.g. cross-tenant isolation assertions) still can.
 *
 * Net effect: harness operations never spuriously fail under the app role,
 * while real route-level RLS / grant bugs surface as test failures.
 */

export { systemDb as db, systemDb, withTenantContext } from "../../lib/db.js";
