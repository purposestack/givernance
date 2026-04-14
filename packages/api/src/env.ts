/** Strict environment validation for the API process — crash early on missing vars */

import { z } from "zod";

const envSchema = z.object({
  /** PostgreSQL connection string */
  DATABASE_URL: z.string().url(),
  /** PostgreSQL connection string (app role, optional — falls back to DATABASE_URL) */
  DATABASE_URL_APP: z.string().url().optional(),
  /** Redis connection URL */
  REDIS_URL: z.string().url(),
  /** S3-compatible endpoint URL */
  S3_ENDPOINT: z.string().url(),
  /** S3 access key */
  S3_ACCESS_KEY_ID: z.string().min(1),
  /** S3 secret key */
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** S3 bucket for receipts */
  S3_RECEIPTS_BUCKET: z.string().min(1).default("receipts"),
  /** S3 region */
  S3_REGION: z.string().min(1).default("us-east-1"),
  /** JWT secret for token verification */
  JWT_SECRET: z.string().min(1),
  /** HTTP port */
  PORT: z.coerce.number().int().positive().default(4000),
  /** HTTP bind address */
  HOST: z.string().min(1).default("0.0.0.0"),
  /** CORS origin */
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),
  /** Log level */
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** NATS WebSocket URL */
  NATS_URL: z.string().default("ws://localhost:4222"),
});

export type ApiEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`[api] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

export const env: ApiEnv = parsed.data;
