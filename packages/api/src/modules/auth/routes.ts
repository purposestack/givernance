/**
 * Back-channel logout endpoint (issue #76 / PR-2).
 *
 * Keycloak's `givernance-web` client is configured with
 * `backchannel.logout.url=http://<api>/v1/auth/backchannel-logout` and
 * `backchannel.logout.session.required=true`. When an upstream session is
 * ended (admin "Sign out all sessions", sibling-device logout, idle
 * timeout), Keycloak makes a server-side POST to this endpoint with a
 * signed `logout_token`.
 *
 * We:
 *   1. Verify the token signature + claims (OIDC Back-Channel Logout 1.0).
 *   2. Blocklist the `sid` in Redis with a TTL covering the realm's max
 *      access-token lifespan, so any in-flight access token carrying that
 *      `sid` gets rejected on the next request by the auth plugin.
 *
 * The route is exempt from the JWT auth gate (see `isAuthExempt` in
 * `plugins/auth.ts`) because the logout token IS the authentication —
 * Keycloak signs it with the realm key. There is no JWT cookie on this
 * server-to-server call.
 */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  type LogoutTokenClaims,
  verifyBackchannelLogoutToken,
} from "../../lib/keycloak-logout-token.js";
import { ProblemDetailSchema, problemDetail } from "../../lib/schemas.js";
import {
  blocklistKeycloakSession,
  KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S,
} from "../session/service.js";

const LogoutTokenBody = Type.Object({
  /**
   * OIDC Back-Channel Logout 1.0 — § 2.4 logout token (`form-urlencoded`).
   * Keycloak posts a single `logout_token` parameter; we verify the JWT
   * and read `sid` out of the claims.
   */
  logout_token: Type.String({ minLength: 1 }),
});

const BackchannelLogoutResponse = Type.Object({
  // Per spec the body is free-form; a tiny object with the revoked sid
  // helps log inspection. The endpoint MUST return 200 on success and
  // 400 on a malformed/forged token (§ 2.8).
  sid: Type.String(),
});

export async function authRoutes(app: FastifyInstance) {
  // Plugin-scoped form parser — Keycloak posts the logout token as
  // `application/x-www-form-urlencoded`, which the global Fastify
  // installation doesn't parse. Scoping it to this plugin avoids
  // accidentally enabling form parsing for unrelated v1 routes.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      const params = new URLSearchParams(raw);
      done(null, { logout_token: params.get("logout_token") ?? "" });
    },
  );

  /**
   * POST /v1/auth/backchannel-logout
   *
   * `200` on success (sid blocklisted). `400` on any verification failure
   * — per spec, the only success/failure distinction returned to Keycloak
   * is 200 vs 400; we never 401 or 5xx (those would prompt Keycloak to
   * retry, which we don't want for a forged-token attempt).
   */
  app.post(
    "/auth/backchannel-logout",
    {
      // Per OIDC spec § 2.8: the logout endpoint MUST NOT cache responses.
      // Also disable rate-limit on this endpoint — Keycloak is the
      // sole authorised caller and a single mass-revocation burst (e.g.
      // admin "Sign out all sessions" across many users) is legitimate.
      config: { rateLimit: false },
      schema: {
        tags: ["Auth"],
        body: LogoutTokenBody,
        response: {
          200: BackchannelLogoutResponse,
          400: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { logout_token } = request.body as { logout_token: string };

      let claims: LogoutTokenClaims;
      try {
        claims = await verifyBackchannelLogoutToken(logout_token);
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "backchannel-logout: token verification failed",
        );
        return reply
          .status(400)
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .send(problemDetail(400, "Bad Request", "Logout token verification failed."));
      }

      await blocklistKeycloakSession(claims.sid, KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S);

      request.log.info(
        {
          sid: claims.sid,
          sub: claims.sub,
          jti: claims.jti,
        },
        "backchannel-logout: sid blocklisted",
      );

      return reply
        .status(200)
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send({ sid: claims.sid });
    },
  );
}
