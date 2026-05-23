/** Drizzle ORM client — PostgreSQL connection via pg pool */

import * as schema from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL_APP ?? env.DATABASE_URL,
  max: 20,
});

/**
 * Owner-role pool — connects as `givernance` (BYPASSRLS), used for system
 * operations that originate from unauthenticated requests and therefore have
 * no `app.current_organization_id` to set. The most common case is validating
 * an unguessable token (signup/verify, signup/resend) before the caller
 * could possibly know the tenant id. The token IS the security boundary
 * here, not RLS — using the app role would silently return zero rows.
 *
 * Do NOT use this for anything that runs on behalf of an authenticated user;
 * those paths must keep going through `db` so RLS isolates tenants.
 *
 * Pool sized to 10 (was 5): `verifySignup` holds a transactional connection
 * across three sequential Keycloak admin HTTP calls (createOrganization,
 * createUser, attachUserToOrg). Each call is rate-limited by the KC client's
 * retry budget (POST is not retried on 5xx, so worst-case ~1 retry on 401
 * rotation), but a flood of half-failed signups can still hold connections
 * for several seconds each. Splitting the verify into pre-validate /
 * KC-orchestrate / finalize sub-transactions is the proper fix; tracked as
 * a follow-up. Until then, doubling the pool gives headroom against the
 * accidental exhaustion path that would block all unauthenticated /signup/*
 * endpoints simultaneously.
 */
const systemPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

/** Drizzle ORM instance with typed schema (app role — RLS enforced) */
export const db = drizzle(pool, { schema });

/** Drizzle ORM instance bound to the owner role — bypasses RLS. See `systemPool` above. */
export const systemDb = drizzle(systemPool, { schema });

/**
 * Execute a callback within a Drizzle transaction that has RLS tenant context set.
 *
 * Using `set_config(..., true)` (transaction-scoped) inside `db.transaction()` guarantees
 * the GUC is pinned to the single pooled connection held by the transaction. This eliminates
 * the cross-request pool leak that occurred with the old session-scoped `set_config(..., false)`
 * in the preHandler plugin.
 */
export async function withTenantContext<T>(
  orgId: string,
  callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    throw new Error("withTenantContext: invalid orgId format");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    return callback(tx);
  });
}

/**
 * Boot-time guard (issue #430): verify that the application pool's
 * runtime role is NOT a BYPASSRLS role. RLS is the safety net we use
 * for tenant isolation alongside the explicit `eq(orgId, …)` filter
 * the application code carries; if the runtime role bypasses RLS, the
 * safety net is gone and a single missed `eq` would leak cross-tenant
 * (which is exactly the 2026-05-23 staging incident: `DATABASE_URL_APP`
 * pointed to the owner role `givernance` with `rolbypassrls=t`).
 *
 * Crash fast on misconfig — the alternative is a silent leak.
 */
export async function assertAppRoleSecure(): Promise<void> {
  const res = await pool.query<{
    current_user: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>(
    "SELECT current_user, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user",
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error("assertAppRoleSecure: unable to resolve current_user against pg_roles");
  }
  if (row.rolsuper) {
    throw new Error(
      `FATAL: DATABASE_URL_APP connects as SUPERUSER role '${row.current_user}'. RLS is bypassed across the stack. Fix DATABASE_URL_APP to use 'givernance_app' (see issue #430).`,
    );
  }
  if (row.rolbypassrls) {
    throw new Error(
      `FATAL: DATABASE_URL_APP connects as BYPASSRLS role '${row.current_user}'. RLS is bypassed across the stack. Fix DATABASE_URL_APP to use 'givernance_app' (see issue #430).`,
    );
  }
}
