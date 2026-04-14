/** Structured Pino logger for the worker process */

import pino from "pino";

export const logger = pino({
  name: "givernance-worker",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Create a child logger with job-specific context */
export function jobLogger(fields: { tenantId?: string; jobId?: string; traceId?: string }) {
  return logger.child(fields);
}
