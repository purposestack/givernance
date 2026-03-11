/** Database client for migration package */

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '@givernance/shared/schema'

const pool = new pg.Pool({
  connectionString:
    process.env['DATABASE_URL'] ?? 'postgresql://givernance:givernance_dev@localhost:5432/givernance',
  max: 5,
})

/** Drizzle ORM instance for migrations */
export const db = drizzle(pool, { schema })
