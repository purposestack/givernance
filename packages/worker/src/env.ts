/** Strict environment validation for the worker process — crash early on missing vars */

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
  /** PostgreSQL connection string (owner role, bypasses RLS) */
  DATABASE_URL: Type.String({ minLength: 1 }),
  /** PostgreSQL connection string (app role, subject to RLS) */
  DATABASE_URL_APP: Type.String({ minLength: 1 }),
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
  /** S3 bucket for campaign documents */
  S3_CAMPAIGNS_BUCKET: Type.String({ minLength: 1, default: "campaigns" }),
  /** S3 region */
  S3_REGION: Type.String({ minLength: 1, default: "us-east-1" }),
  /** Log level */
  LOG_LEVEL: LogLevel,
  /** Stripe secret key (sk_test_... or sk_live_...) */
  STRIPE_SECRET_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** ExchangeRate-API key used for currency conversion refreshes */
  EXCHANGE_RATE_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** SMTP host for outbound mail — defaults to local Mailpit */
  SMTP_HOST: Type.String({ minLength: 1, default: "localhost" }),
  /** SMTP port (1025 for Mailpit, 587 for submission, 465 for SMTPS) */
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 1025 }),
  /** SMTP username — leave unset (empty) for auth-less dev relays like Mailpit */
  SMTP_USER: Type.Optional(Type.String()),
  /** SMTP password — leave unset (empty) for auth-less dev relays like Mailpit */
  SMTP_PASS: Type.Optional(Type.String()),
  /** RFC 5322 From header for outbound mail */
  SMTP_FROM: Type.String({ minLength: 1, default: "Givernance <no-reply@givernance.local>" }),
  /** Public URL of the web app — used to build verification links sent by email */
  APP_URL: Type.String({ minLength: 1, default: "http://localhost:3000" }),
});

export type WorkerEnv = Static<typeof EnvSchema>;

const value = Value.Default(EnvSchema, Value.Convert(EnvSchema, { ...process.env }));

if (!Value.Check(EnvSchema, value)) {
  const errors = [...Value.Errors(EnvSchema, value)];
  const formatted = errors.map((e) => `  ${e.path.slice(1)}: ${e.message}`).join("\n");
  console.error(`[worker] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

export const env: WorkerEnv = value;
