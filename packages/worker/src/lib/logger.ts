/** Structured Pino logger for the worker process */

import { PINO_REDACT_PATHS } from "@givernance/shared/constants";
import pino from "pino";

export const logger = pino({
  name: "givernance-worker",
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "givernance-worker", env: process.env.NODE_ENV },
  redact: [...PINO_REDACT_PATHS],
});

/** Create a child logger with job-specific context */
export function jobLogger(fields: { tenantId?: string; jobId?: string; traceId?: string }) {
  return logger.child(fields);
}
