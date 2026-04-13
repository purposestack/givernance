/**
 * Vitest global setup — ensures env vars are set before any module loads.
 * DATABASE_URL must point to a running PostgreSQL instance (docker-compose locally, service container in CI).
 */

process.env.DATABASE_URL ??= "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
process.env.JWT_SECRET ??= "test-secret";
process.env.LOG_LEVEL ??= "silent";
