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
