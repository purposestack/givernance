/** Structured Pino logger for the worker process */

import pino from "pino";

export const logger = pino({
  name: "givernance-worker",
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "givernance-worker", env: process.env.NODE_ENV },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "body.password",
    "body.token",
    "body.iban",
    "body.cardNumber",
    "body.cvv",
    "body.pan",
    "headers.authorization",
    "headers.cookie",
  ],
});

/** Create a child logger with job-specific context */
export function jobLogger(fields: { tenantId?: string; jobId?: string; traceId?: string }) {
  return logger.child(fields);
}
