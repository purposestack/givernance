/**
 * Vitest global setup — ensures env vars are set before any module loads.
 * Mirrors the worker package's setup so both packages can share the same
 * CI Postgres + Redis service instances.
 */

process.env.DATABASE_URL ??=
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.LOG_LEVEL ??= "silent";
