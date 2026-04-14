/** Structured Pino logger for the outbox relay process */

import pino from "pino";

export const logger = pino({
  name: "givernance-relay",
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "givernance-relay", env: process.env.NODE_ENV },
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
