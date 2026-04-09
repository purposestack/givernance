/** JWT validation plugin — verifies Keycloak-issued OIDC tokens */

import fjwt from "@fastify/jwt";
import type { AuthContext } from "@givernance/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

async function auth(app: FastifyInstance) {
  await app.register(fjwt, {
    secret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
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
      }>();

      request.auth = {
        userId: decoded.sub,
        orgId: decoded.org_id,
        roles: decoded.realm_access?.roles ?? [],
        email: decoded.email,
      };
    } catch {
      // Auth will be null for unauthenticated requests
    }
  });
}

export const authPlugin = fp(auth, { name: "auth" });
