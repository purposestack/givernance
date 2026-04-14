/** Strict environment validation for the outbox relay process — crash early on missing vars */

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
  /** Redis connection URL */
  REDIS_URL: Type.String({ minLength: 1 }),
  /** Outbox polling interval in milliseconds */
  OUTBOX_POLL_INTERVAL_MS: Type.Number({ default: 500 }),
  /** Log level */
  LOG_LEVEL: LogLevel,
});

export type RelayEnv = Static<typeof EnvSchema>;

const value = Value.Default(EnvSchema, Value.Convert(EnvSchema, { ...process.env }));

if (!Value.Check(EnvSchema, value)) {
  const errors = [...Value.Errors(EnvSchema, value)];
  const formatted = errors.map((e) => `  ${e.path.slice(1)}: ${e.message}`).join("\n");
  console.error(`[relay] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

export const env: RelayEnv = value;
