/** Strict environment validation for the worker process — crash early on missing vars */

import { z } from "zod";

const envSchema = z.object({
  /** PostgreSQL connection string (owner role, bypasses RLS) */
  DATABASE_URL: z.string().url(),
  /** PostgreSQL connection string (app role, subject to RLS) */
  DATABASE_URL_APP: z.string().url(),
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
  /** S3 bucket for campaign documents */
  S3_CAMPAIGNS_BUCKET: z.string().min(1).default("campaigns"),
  /** S3 region */
  S3_REGION: z.string().min(1).default("us-east-1"),
  /** Log level */
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type WorkerEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`[worker] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

export const env: WorkerEnv = parsed.data;
