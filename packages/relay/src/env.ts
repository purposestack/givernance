/** Strict environment validation for the outbox relay process — crash early on missing vars */

import { z } from "zod";

const envSchema = z.object({
  /** PostgreSQL connection string */
  DATABASE_URL: z.string().url(),
  /** Redis connection URL */
  REDIS_URL: z.string().url(),
  /** Outbox polling interval in milliseconds */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  /** Log level */
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type RelayEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`[relay] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

export const env: RelayEnv = parsed.data;
