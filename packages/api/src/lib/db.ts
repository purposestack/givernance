/** Drizzle ORM client — PostgreSQL connection via pg pool */

import * as schema from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL_APP ??
    process.env.DATABASE_URL ??
    "postgresql://givernance:givernance_dev@localhost:5432/givernance",
  max: 20,
});

/** Drizzle ORM instance with typed schema */
export const db = drizzle(pool, { schema });

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
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`);
    return callback(tx);
  });
}
