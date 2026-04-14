/** Drizzle ORM client for worker — connects as givernance (owner, bypasses RLS) */

import * as schema from "@givernance/shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://givernance:givernance_dev@localhost:5432/givernance",
  max: 10,
});

/** Drizzle ORM instance — worker role (owner, bypasses RLS) */
export const db = drizzle(pool, { schema });
