/** Drizzle ORM client — PostgreSQL connection via pg pool */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '@givernance/shared/schema'

const pool = new pg.Pool({
  connectionString:
    process.env['DATABASE_URL'] ?? 'postgresql://givernance:givernance_dev@localhost:5432/givernance',
  max: 20,
})

/** Drizzle ORM instance with typed schema */
export const db = drizzle(pool, { schema })
