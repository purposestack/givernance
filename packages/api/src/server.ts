/** Fastify app factory — registers all plugins and routes */

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { env } from "./env.js";
import { redis } from "./lib/redis.js";
import { PROBLEM_JSON, problemDetail } from "./lib/schemas.js";
import { impersonationRoutes } from "./modules/admin/impersonation-routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { campaignRoutes } from "./modules/campaigns/routes.js";
import { constituentRoutes } from "./modules/constituents/routes.js";
import { donationRoutes } from "./modules/donations/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { invitationRoutes } from "./modules/invitations/routes.js";
import { paymentRoutes, stripeWebhookRoute } from "./modules/payments/routes.js";
import { pledgeRoutes } from "./modules/pledges/routes.js";
import { publicDonationRoutes } from "./modules/public/routes.js";
import { reportsRoutes } from "./modules/reports/routes.js";
import { signupRoutes } from "./modules/signup/routes.js";
import { tenantRoutes } from "./modules/tenants/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { auditPlugin } from "./plugins/audit.js";
import { authPlugin } from "./plugins/auth.js";

/** Create and configure the Fastify server instance */
export async function createServer() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { service: "givernance-api", env: process.env.NODE_ENV },
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
    },
  });

  // --- Core plugins ---
  await app.register(cors, {
    origin: env.APP_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(rateLimit, {
    global: false, // Only apply to routes that opt in
    max: 100,
    timeWindow: "1 minute",
    redis,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Givernance API",
        description: "CRM API for European nonprofits",
        version: "0.1.0",
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // --- Global error handler (RFC 9457 application/problem+json) ---
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    const body = {
      ...problemDetail(
        status,
        error.message || "Internal Server Error",
        error.validation
          ? `Validation failed: ${error.validation.map((v) => v.message).join("; ")}`
          : error.message || "An unexpected error occurred",
      ),
      ...(error.validation ? { fieldErrors: buildFieldErrors(error.validation) } : {}),
    };
    return reply.status(status).header("content-type", PROBLEM_JSON).send(body);
  });

  // --- Custom plugins ---
  await app.register(authPlugin);
  await app.register(auditPlugin);

  // --- Routes ---
  await app.register(healthRoutes);
  await app.register(constituentRoutes, { prefix: "/v1" });
  await app.register(tenantRoutes, { prefix: "/v1" });
  await app.register(userRoutes, { prefix: "/v1" });
  await app.register(invitationRoutes, { prefix: "/v1" });
  await app.register(auditRoutes, { prefix: "/v1" });
  await app.register(donationRoutes, { prefix: "/v1" });
  await app.register(pledgeRoutes, { prefix: "/v1" });
  await app.register(campaignRoutes, { prefix: "/v1" });
  await app.register(paymentRoutes, { prefix: "/v1" });
  await app.register(stripeWebhookRoute, { prefix: "/v1" });
  await app.register(publicDonationRoutes, { prefix: "/v1" });
  await app.register(signupRoutes, { prefix: "/v1" });
  await app.register(reportsRoutes, { prefix: "/v1" });
  await app.register(impersonationRoutes, { prefix: "/v1" });

  return app;
}

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  params?: {
    missingProperty?: string;
  };
}

function buildFieldErrors(validation: FastifyError["validation"]): Record<string, string> {
  if (!validation) return {};

  const fieldErrors: Record<string, string> = {};
  for (const issue of validation as ValidationIssue[]) {
    const fieldName = extractFieldName(issue);
    if (!fieldName || fieldErrors[fieldName]) continue;
    fieldErrors[fieldName] = issue.message ?? "Invalid value";
  }
  return fieldErrors;
}

function extractFieldName(issue: ValidationIssue): string | null {
  if (issue.params?.missingProperty) return issue.params.missingProperty;

  const path = issue.instancePath ?? "";
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "body") segments.shift();
  const candidate = segments.at(-1);
  return candidate && /^[A-Za-z0-9_]+$/.test(candidate) ? candidate : null;
}
