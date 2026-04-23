/** JWT validation plugin — verifies Keycloak-issued OIDC tokens against the realm JWKS. */

import { timingSafeEqual } from "node:crypto";

import cookie from "@fastify/cookie";
import type { AuthContext, UserRole } from "@givernance/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { verifyKeycloakJwt } from "../lib/keycloak-jwt.js";
import { problemDetail } from "../lib/schemas.js";
import { isSessionBlocklisted } from "../modules/session/service.js";

const JWT_COOKIE_NAME = "givernance_jwt";
const CSRF_COOKIE_NAME = "csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** JWT `jti` claim — used by the session blocklist for `switch-org` revocations. */
    jwtJti: string | null;
    /** JWT `exp` (seconds-epoch) — used when blocklisting to TTL the key. */
    jwtExp: number | null;
  }
}

async function auth(app: FastifyInstance) {
  await app.register(cookie);

  /** Extract auth context from verified JWT claims */
  app.decorateRequest("auth", null);
  app.decorateRequest("jwtJti", null);
  app.decorateRequest("jwtExp", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isAuthExempt(request.url)) return;

    const blocklisted = await applyAuthFromToken(request);
    if (blocklisted) {
      return reply.status(401).send(problemDetail(401, "Unauthorized", "Session revoked."));
    }

    if (!requiresCsrfCheck(request)) return;

    if (!csrfTokenValid(request)) {
      return reply
        .status(403)
        .send(problemDetail(403, "Forbidden", "Missing or invalid CSRF double-submit token"));
    }
  });
}

function isAuthExempt(url: string): boolean {
  return url.startsWith("/healthz") || url.startsWith("/readyz") || url.startsWith("/docs");
}

/** Returns `true` if the request's session is blocklisted and the caller should reject. */
async function applyAuthFromToken(request: FastifyRequest): Promise<boolean> {
  try {
    const token = extractToken(request);
    if (!token) return false;

    const decoded = await verifyKeycloakJwt(token);

    // Reject tokens revoked by a `switch-org` call (ADR-016 / doc 22 §6.3).
    // Blocklist check lives in Redis; a missing `jti` means the upstream
    // realm didn't emit one — the switch endpoint will still authorise
    // itself, but will not be able to revoke the prior session.
    if (decoded.jti && (await isSessionBlocklisted(decoded.jti))) {
      return true;
    }

    request.auth = {
      userId: decoded.sub,
      orgId: decoded.org_id,
      roles: decoded.realm_access?.roles ?? [],
      email: decoded.email,
      role: decoded.role as UserRole | undefined,
      act: decoded.act,
    };
    request.jwtJti = decoded.jti ?? null;
    request.jwtExp = typeof decoded.exp === "number" ? decoded.exp : null;
  } catch {
    // Auth will be null for unauthenticated requests
  }
  return false;
}

function requiresCsrfCheck(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  return Boolean(request.cookies[JWT_COOKIE_NAME]);
}

function csrfTokenValid(request: FastifyRequest): boolean {
  const csrfCookie = request.cookies[CSRF_COOKIE_NAME];
  const csrfHeader = request.headers[CSRF_HEADER_NAME];
  if (!csrfCookie || typeof csrfHeader !== "string") return false;
  return tokensMatch(csrfCookie, csrfHeader);
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
