/**
 * Vitest global setup — ensures env vars are set before any module loads.
 * DATABASE_URL must point to a running PostgreSQL instance (docker-compose locally, service container in CI).
 */

import { once } from "node:events";
import { createServer } from "node:http";

process.env.DATABASE_URL ??=
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
// DATABASE_URL_APP intentionally NOT set in tests — falls back to DATABASE_URL (owner role).
// The givernance_app role is created by migration 0005 and applied in real environments;
// tests use the owner role so they can set up fixtures without RLS restrictions.
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";
process.env.ADMIN_SECRET ??= "test-secret";
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
