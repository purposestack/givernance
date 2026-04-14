/**
 * Vitest global setup — ensures env vars are set before any module loads.
 * DATABASE_URL must point to a running PostgreSQL instance (docker-compose locally, service container in CI).
 */

process.env.DATABASE_URL ??=
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
// DATABASE_URL_APP intentionally NOT set in tests — falls back to DATABASE_URL (owner role).
// The givernance_app role is created by migration 0005 and applied in real environments;
// tests use the owner role so they can set up fixtures without RLS restrictions.
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";
process.env.JWT_SECRET ??= "test-secret";
process.env.ADMIN_SECRET ??= "test-secret";
process.env.LOG_LEVEL ??= "silent";
