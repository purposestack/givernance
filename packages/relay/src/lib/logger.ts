/** Structured Pino logger for the outbox relay process */

import { PINO_REDACT_PATHS } from "@givernance/shared/constants";
import pino from "pino";

export const logger = pino({
  name: "givernance-relay",
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "givernance-relay", env: process.env.NODE_ENV },
  redact: [...PINO_REDACT_PATHS],
});
