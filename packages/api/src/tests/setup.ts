/**
 * Vitest global setup — ensures env vars are set before any module loads.
 * DATABASE_URL must point to a running PostgreSQL instance (docker-compose locally, service container in CI).
 */

import { once } from "node:events";
import { createServer } from "node:http";

process.env.DATABASE_URL ??=
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";

// Dual-role test execution (issue #455).
//
// The route-path pool (`db` in `lib/db.ts`) connects as
// `env.DATABASE_URL_APP ?? env.DATABASE_URL`. CI runs the integration suite
// under BOTH roles:
//
//   • `api-tests-owner` — DATABASE_URL_APP_TEST unset → `db` falls back to
//     DATABASE_URL (the `givernance` owner role, BYPASSRLS). Ergonomic: fixture
//     setup can write platform tables freely. This is also the local-dev
//     default, so a bare `pnpm test` keeps working with zero extra config.
//
//   • `api-tests-app` — DATABASE_URL_APP_TEST points at the `givernance_app`
//     role (NOBYPASSRLS, created by migration 0005). Every route query then
//     goes through RLS, so any route that forgot `withTenantContext` — or that
//     wrongly used the tenant pool on a REVOKE'd platform table — fails RED
//     instead of silently passing. This is the must-pass gate.
//
// We map DATABASE_URL_APP_TEST → DATABASE_URL_APP here (before `env.ts` reads
// process.env) rather than setting DATABASE_URL_APP directly in CI so the two
// concerns stay separable: the *test* role swap never risks leaking into a
// real DATABASE_URL_APP a developer may have exported for another purpose.
//
// Test *harness* code (fixtures + verification reads) deliberately stays on the
// owner role regardless of this swap — it imports `db` from
// `tests/helpers/db.js` (which re-exports the owner pool), so seeding any
// tenant's rows never trips RLS. See that file's header for the rationale.
if (process.env.DATABASE_URL_APP_TEST) {
  process.env.DATABASE_URL_APP = process.env.DATABASE_URL_APP_TEST;
}
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";
process.env.ADMIN_SECRET ??= "test-secret";
// Stripe credentials — `getStripe()` requires a non-empty value to construct
// the SDK client. The actual key is never used by tests (the `stripe` module
// is mocked in test files that exercise the real service path); just needs
// to pass the env-validation gate.
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy_for_tests";
process.env.LOG_LEVEL ??= "silent";

const TEST_JWKS = {
  keys: [
    {
      kty: "RSA",
      kid: "test-key-1",
      use: "sig",
      alg: "RS256",
      n: "w05xLAFrvHm8rwwlvA2JytfN1vW0JKsUcDmIes2JgYu3rmS7uQsFiowUCFytkYjaBNqq2hV-qos-OemwaQ4AktUtYteF0ATq3uv_X5eYSfqG1D2Gxva6NtswdL2YZpDY3O6o9r3r81M6NzNuQCtlnPienYH9jAox5Io5CrnPtC5_eF6gLaU1FwnGApQE1xSpAjxcEOh14nJLiu-_bhZk_yko4wriB0GpPNpytNH0711Vs2pvpRhLw1_ZEjk8lPIjueGGg1Jmznr6b6D_XB6jdwuXIXuPllA8Tirewas--rwOwaQnfeKbXcXPfkjDYMjiXDAQoqt7riu4TnyqN9v9NQ",
      e: "AQAB",
    },
  ],
};

const jwksServer = createServer((req, res) => {
  if (req.url !== "/.well-known/jwks.json") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(TEST_JWKS));
});

jwksServer.listen(0, "127.0.0.1");
await once(jwksServer, "listening");

const address = jwksServer.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to start test JWKS server");
}

process.env.KEYCLOAK_ISSUER ??= "https://keycloak.test/realms/givernance";
process.env.KEYCLOAK_JWKS_URL ??= `http://127.0.0.1:${address.port}/.well-known/jwks.json`;

// Seed the canonical test tenants + users once per test run. The auth
// plugin's active-row check (ADR-021) requires `(keycloak_id, org_id,
// deleted_at IS NULL)` to resolve before any authenticated request
// passes — without these rows, every `signToken`-authenticated test 401s.
// `ensureTestTenants` is idempotent, but importing it here from the
// helpers ensures every test file (whether or not it calls the helper
// directly) has the fixture available.
const { ensureTestTenants } = await import("./helpers/auth.js");
await ensureTestTenants();
