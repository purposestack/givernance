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
