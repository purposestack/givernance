/** Strict environment validation for the API process — crash early on missing vars */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LogLevel = Type.Union(
  [
    Type.Literal("fatal"),
    Type.Literal("error"),
    Type.Literal("warn"),
    Type.Literal("info"),
    Type.Literal("debug"),
    Type.Literal("trace"),
    Type.Literal("silent"),
  ],
  { default: "info" },
);

const EnvSchema = Type.Object({
  /** PostgreSQL connection string */
  DATABASE_URL: Type.String({ minLength: 1 }),
  /** PostgreSQL connection string (app role, optional — falls back to DATABASE_URL) */
  DATABASE_URL_APP: Type.Optional(Type.String({ minLength: 1 })),
  /** Redis connection URL */
  REDIS_URL: Type.String({ minLength: 1 }),
  /** S3-compatible endpoint URL */
  S3_ENDPOINT: Type.String({ minLength: 1 }),
  /** S3 access key */
  S3_ACCESS_KEY_ID: Type.String({ minLength: 1 }),
  /** S3 secret key */
  S3_SECRET_ACCESS_KEY: Type.String({ minLength: 1 }),
  /** S3 bucket for receipts */
  S3_RECEIPTS_BUCKET: Type.String({ minLength: 1, default: "receipts" }),
  /** S3 region */
  S3_REGION: Type.String({ minLength: 1, default: "us-east-1" }),
  /** Keycloak base URL used to derive issuer and JWKS endpoint */
  KEYCLOAK_URL: Type.String({ minLength: 1, default: "http://localhost:8080" }),
  /** Keycloak realm used to derive issuer and JWKS endpoint */
  KEYCLOAK_REALM: Type.String({ minLength: 1, default: "givernance" }),
  /** Optional explicit issuer override */
  KEYCLOAK_ISSUER: Type.Optional(Type.String({ minLength: 1 })),
  /** Optional explicit JWKS URL override */
  KEYCLOAK_JWKS_URL: Type.Optional(Type.String({ minLength: 1 })),
  /** Keycloak Admin API base URL (defaults to KEYCLOAK_URL). Used by the admin client (ADR-016). */
  KEYCLOAK_ADMIN_URL: Type.Optional(Type.String({ minLength: 1 })),
  /** Service-account client id used for Keycloak Admin API calls. */
  KEYCLOAK_ADMIN_CLIENT_ID: Type.String({ minLength: 1, default: "givernance-admin" }),
  /** Service-account client secret used for Keycloak Admin API calls. */
  KEYCLOAK_ADMIN_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  /** HTTP port */
  PORT: Type.Number({ default: 4000 }),
  /** HTTP bind address */
  HOST: Type.String({ minLength: 1, default: "0.0.0.0" }),
  /** App URL — used as CORS origin and cookie domain */
  APP_URL: Type.String({ minLength: 1, default: "http://localhost:3000" }),
  /** Log level */
  LOG_LEVEL: LogLevel,
  /** NATS WebSocket URL */
  NATS_URL: Type.String({ default: "ws://localhost:4222" }),
  /** Stripe secret key (sk_test_... or sk_live_...) */
  STRIPE_SECRET_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** Stripe webhook endpoint secret (whsec_...) */
  STRIPE_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 1 })),
});

export type ApiEnv = Static<typeof EnvSchema>;

const value = Value.Default(EnvSchema, Value.Convert(EnvSchema, { ...process.env }));

if (!Value.Check(EnvSchema, value)) {
  const errors = [...Value.Errors(EnvSchema, value)];
  const formatted = errors.map((e) => `  ${e.path.slice(1)}: ${e.message}`).join("\n");
  console.error(`[api] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !value.DATABASE_URL_APP) {
  console.error("[api] DATABASE_URL_APP is strictly required in production for RLS isolation.");
  process.exit(1);
}

export const env: ApiEnv = value;
