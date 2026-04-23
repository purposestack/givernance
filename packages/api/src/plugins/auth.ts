/** JWT validation plugin — verifies Keycloak-issued OIDC tokens against the realm JWKS. */

import { timingSafeEqual } from "node:crypto";

import cookie from "@fastify/cookie";
import type { AuthContext, UserRole } from "@givernance/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { verifyKeycloakJwt } from "../lib/keycloak-jwt.js";
import { problemDetail } from "../lib/schemas.js";

const JWT_COOKIE_NAME = "givernance_jwt";
const CSRF_COOKIE_NAME = "csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

async function auth(app: FastifyInstance) {
  await app.register(cookie);

  /** Extract auth context from verified JWT claims */
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health checks and docs
    if (
      request.url.startsWith("/healthz") ||
      request.url.startsWith("/readyz") ||
      request.url.startsWith("/docs")
    ) {
      return;
    }

    try {
      const token = extractToken(request);
      if (token) {
        const decoded = await verifyKeycloakJwt(token);

        request.auth = {
          userId: decoded.sub,
          orgId: decoded.org_id,
          roles: decoded.realm_access?.roles ?? [],
          email: decoded.email,
          role: decoded.role as UserRole | undefined,
          act: decoded.act,
        };
      }
    } catch {
      // Auth will be null for unauthenticated requests
    }

    if (SAFE_METHODS.has(request.method) || !request.cookies[JWT_COOKIE_NAME]) {
      return;
    }

    const csrfCookie = request.cookies[CSRF_COOKIE_NAME];
    const csrfHeader = request.headers[CSRF_HEADER_NAME];

    if (!csrfCookie || typeof csrfHeader !== "string" || !tokensMatch(csrfCookie, csrfHeader)) {
      return reply
        .status(403)
        .send(problemDetail(403, "Forbidden", "Missing or invalid CSRF double-submit token"));
    }
  });
}

function tokensMatch(cookieValue: string, headerValue: string): boolean {
  const cookieToken = Buffer.from(cookieValue);
  const headerToken = Buffer.from(headerValue);

  if (cookieToken.length !== headerToken.length) {
    return false;
  }

  return timingSafeEqual(cookieToken, headerToken);
}

export const authPlugin = fp(auth, { name: "auth" });

function extractToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return request.cookies[JWT_COOKIE_NAME] ?? null;
}
