/** Drizzle ORM client for worker — dual-pool: owner for migrations, app role for tenant-scoped work */

import * as schema from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner pool — bypasses RLS. Only for non-tenant-scoped operations. */
const ownerPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
});

/** App-role pool — subject to RLS policies. Used by withWorkerContext. */
const appPool = new pg.Pool({
  connectionString: env.DATABASE_URL_APP,
  max: 10,
});

/** Drizzle ORM instance — owner role (bypasses RLS). Use only for cross-tenant ops. */
export const db = drizzle(ownerPool, { schema });

/** Drizzle ORM instance — app role (subject to RLS). Used inside withWorkerContext. */
const appDb: NodePgDatabase<typeof schema> = drizzle(appPool, { schema });

/**
 * Execute a callback within a transaction that enforces RLS tenant isolation.
 *
 * Connects as `givernance_app` (subject to RLS) and pins `app.current_organization_id`
 * to the transaction, ensuring the worker cannot accidentally read or write
 * data belonging to another tenant.
 */
export async function withWorkerContext<T>(
  orgId: string,
  callback: (tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    throw new Error("withWorkerContext: invalid orgId format");
  }

  return appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    return callback(tx);
  });
}

/**
 * Boot-time guard (issue #430): the worker's app pool must connect as
 * a NOBYPASSRLS role. The 2026-05-23 staging incident traced back to
 * `DATABASE_URL_APP` pointing at the owner role (`rolbypassrls=t`),
 * which silently bypassed the `users.tenant_isolation` policy and
 * fanned out notifications to every org_admin in every tenant. Crash
 * fast on misconfig — a silent leak is worse than no boot.
 */
export async function assertWorkerAppRoleSecure(): Promise<void> {
  const res = await appPool.query<{
    current_user: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>(
    "SELECT current_user, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user",
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error("assertWorkerAppRoleSecure: unable to resolve current_user against pg_roles");
  }
  if (row.rolsuper) {
    throw new Error(
      `FATAL: worker DATABASE_URL_APP connects as SUPERUSER role '${row.current_user}'. RLS is bypassed across the worker. Fix DATABASE_URL_APP to use 'givernance_app' (see issue #430).`,
    );
  }
  if (row.rolbypassrls) {
    throw new Error(
      `FATAL: worker DATABASE_URL_APP connects as BYPASSRLS role '${row.current_user}'. RLS is bypassed across the worker. Fix DATABASE_URL_APP to use 'givernance_app' (see issue #430).`,
    );
  }
}
