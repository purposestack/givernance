/** Drizzle Kit configuration — points to shared schema package */

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../shared/src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://givernance:givernance_dev@localhost:5432/givernance',
  },
})
