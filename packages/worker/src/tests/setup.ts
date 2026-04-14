/**
 * Vitest global setup — ensures env vars are set before any module loads.
 */

process.env.DATABASE_URL ??=
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
// In tests, both pools use the owner role against the test DB (no givernance_app role needed).
process.env.DATABASE_URL_APP ??=
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";
process.env.S3_RECEIPTS_BUCKET ??= "receipts";
process.env.LOG_LEVEL ??= "silent";
