/** JWT validation plugin — verifies Keycloak-issued OIDC tokens (Phase 0: @fastify/jwt) */

import fjwt from "@fastify/jwt";
import type { AuthContext, UserRole } from "@givernance/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

async function auth(app: FastifyInstance) {
  await app.register(fjwt, {
    secret: process.env["JWT_SECRET"] ?? "dev-secret-change-in-production",
  });

  /** Extract auth context from verified JWT claims */
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    // Skip auth for health checks and docs
    if (
      request.url.startsWith("/healthz") ||
      request.url.startsWith("/readyz") ||
      request.url.startsWith("/docs")
    ) {
      return;
    }

    try {
      const decoded = await request.jwtVerify<{
        sub: string;
        org_id: string;
        realm_access?: { roles: string[] };
        email: string;
        /** Application-level role claim */
        role?: string;
        /** RFC 8693 §4.1 actor claim — present on delegation/impersonation tokens */
        act?: { sub: string };
      }>();

      request.auth = {
        userId: decoded.sub,
        orgId: decoded.org_id,
        roles: decoded.realm_access?.roles ?? [],
        email: decoded.email,
        role: decoded.role as UserRole | undefined,
        act: decoded.act,
      };
    } catch {
      // Auth will be null for unauthenticated requests
    }
  });
}

export const authPlugin = fp(auth, { name: "auth" });
