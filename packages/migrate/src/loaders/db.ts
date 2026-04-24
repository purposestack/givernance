/** Database client for migration package */

import * as schema from "@givernance/shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// Fail fast if DATABASE_URL is missing rather than silently default to a dev
// Postgres — PR #54 eliminated this pattern elsewhere, this was the last
// hold-out (issue #56 Platform). Silent fallbacks in one-shot ETL tools are
// especially dangerous because they can be pointed at a prod DB by a missing
// envvar and then immediately start writing.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @givernance/migrate. Set it in the environment before running any migration command.",
  );
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

/** Drizzle ORM instance for migrations */
export const db = drizzle(pool, { schema });
