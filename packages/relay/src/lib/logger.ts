/** Structured Pino logger for the outbox relay process */

import pino from "pino";

export const logger = pino({
  name: "givernance-relay",
  level: process.env.LOG_LEVEL ?? "info",
});
