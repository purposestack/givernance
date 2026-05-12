/**
 * Session-lifecycle routes (issue #112 / ADR-016 / doc 22 §6.3 + issue #76 / PR-2).
 *
 *  - `GET /v1/users/me/organizations` — cards for the picker.
 *  - `POST /v1/session/switch-org`    — validate + record + blocklist `jti`.
 *  - `POST /v1/session/backchannel-logout` — OIDC Back-Channel Logout 1.0
 *    webhook from Keycloak; blocklists `sid` so any in-flight access
 *    token tied to that upstream session is rejected on next request.
 *
 * The `GET /v1/users/me` endpoint stays in the `users` module; only the
 * multi-tenant listing lives here so the `me` response is not bloated.
 *
 * All three handlers share the `session/service.ts` blocklist primitives
 * (`recordOrgSwitch` writes the jti blocklist, `blocklistKeycloakSession`
 * writes the sid blocklist). PR #360 review (API M1, M10, Architect M1)
 * folded `modules/auth/` into this module so the contract stays coherent.
 */

import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import {
  type LogoutTokenClaims,
  verifyBackchannelLogoutToken,
} from "../../lib/keycloak-logout-token.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  blocklistKeycloakSession,
  KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S,
  listUserOrganizations,
  recordOrgSwitch,
} from "./service.js";

const OrgMembershipSchema = Type.Object({
  orgId: UuidSchema,
  slug: Type.String(),
  name: Type.String(),
  status: Type.String(),
  role: Type.String(),
  firstAdmin: Type.Boolean(),
  provisionalUntil: Type.Union([Type.String(), Type.Null()]),
  primaryDomain: Type.Union([Type.String(), Type.Null()]),
  lastVisitedAt: Type.Union([Type.String(), Type.Null()]),
});

const SwitchOrgBody = Type.Object({
  targetOrgId: UuidSchema,
});

const SwitchOrgResponse = Type.Object({
  targetOrgId: UuidSchema,
  targetSlug: Type.String(),
  targetRole: Type.String(),
});

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function audit(request: FastifyRequest) {
  const ua = request.headers["user-agent"];
  return {
    ipHash: hashIp(request.ip),
    userAgent: typeof ua === "string" ? ua.slice(0, 512) : undefined,
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  /** GET /v1/users/me/organizations — list every tenant this user belongs to. */
  app.get(
    "/users/me/organizations",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Session"],
        response: {
          200: DataArrayResponseNoPagination(OrgMembershipSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const sub = request.auth?.userId as string;
      const rows = await listUserOrganizations(sub);
      return reply.send({ data: rows });
    },
  );

  /** POST /v1/session/switch-org — validate membership + blocklist + record. */
  app.post(
    "/session/switch-org",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Session"],
        body: SwitchOrgBody,
        response: {
          200: DataResponse(SwitchOrgResponse),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { targetOrgId: string };
      const authClaims = request.auth;
      if (!authClaims) {
        return reply
          .status(401)
          .send(problemDetail(401, "Unauthorized", "Authentication required."));
      }

      // Impersonation sessions cannot switch orgs — the `act` claim pins the
      // session to the impersonatee's tenant. (Per ADR-016 / doc 22 §8.)
      if (authClaims.act?.sub) {
        return reply
          .status(403)
          .send(
            problemDetail(
              403,
              "Forbidden",
              "Cannot switch tenants while impersonating. End the impersonation session first.",
            ),
          );
      }

      const res = await recordOrgSwitch({
        keycloakSub: authClaims.userId,
        targetOrgId: body.targetOrgId,
        previousJti: request.jwtJti ?? undefined,
        previousExp: request.jwtExp ?? undefined,
        audit: audit(request),
      });

      if (!res.ok) {
        const { status, title, detail } = switchOrgErrorResponse(res.error);
        return reply.status(status).send(problemDetail(status, title, detail));
      }

      return reply.send({
        data: {
          targetOrgId: res.targetOrgId,
          targetSlug: res.targetSlug,
          targetRole: res.targetRole,
        },
      });
    },
  );

  // ─── Back-channel logout (issue #76 / PR-2) ───────────────────────────
  //
  // OIDC Back-Channel Logout 1.0 webhook. Keycloak's `givernance-web` client
  // is configured with `backchannel.logout.url=…/v1/session/backchannel-logout`
  // and `backchannel.logout.session.required=true`; an upstream session end
  // (admin "Sign out all sessions", sibling-device logout, idle timeout)
  // triggers a server-side POST here carrying a signed `logout_token`.
  //
  // Verify → blocklist sid → next access-token request with that sid is
  // rejected by the auth plugin. Exempt from JWT auth (`isAuthExempt` in
  // `plugins/auth.ts`) — the logout token IS the authentication.

  // Plugin-scoped form parser — Keycloak posts the logout token as
  // `application/x-www-form-urlencoded`, which the global Fastify
  // installation doesn't parse. Scoping it to this `sessionRoutes`
  // plugin avoids accidentally enabling form parsing for unrelated
  // v1 routes (Fastify `register` creates an encapsulation context).
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
   * POST /v1/session/backchannel-logout
   *
   * `200` on success (sid blocklisted). `400` on any verification failure
   * — per spec, the only success/failure distinction returned to Keycloak
   * is 200 vs 400; we never 401 or 5xx (those would prompt Keycloak to
   * retry, which we don't want for a forged-token attempt).
   *
   * Rate-limit: 1000/min soft cap as a DoS floor (Security M3 / API m6).
   * Legitimate mass-revocation bursts (admin "Sign out all sessions"
   * across an entire tenant) stay well under this; a forged-token flood
   * gets capped without disrupting real revocations.
   */
  app.post(
    "/session/backchannel-logout",
    {
      config: { rateLimit: { max: 1000, timeWindow: "1 minute" } },
      schema: {
        tags: ["Session"],
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
          .send(problemDetail(400, "Invalid logout token", "Logout token verification failed."));
      }

      try {
        await blocklistKeycloakSession(claims.sid, KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S);
      } catch (err) {
        // Redis write failed. Return 400 (not 500) so Keycloak doesn't
        // schedule a retry storm — the realm will surface the failure
        // via the upstream "Failed back-channel logout" admin event,
        // which is the right place for operators to find it.
        request.log.error(
          { err: err instanceof Error ? err.message : String(err), sid: claims.sid },
          "backchannel-logout: Redis blocklist write failed",
        );
        return reply
          .status(400)
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .send(problemDetail(400, "Logout failed", "Could not persist session revocation."));
      }

      request.log.info(
        {
          sid: claims.sid,
          // PR #360 review (API C9 — GDPR redaction posture): hash the
          // Keycloak `sub` rather than logging it raw. `sub` is a stable
          // pseudonymous identifier (GDPR Art. 4(5)) — pseudonymisation
          // is fine in audit logs, but the canonical pattern in this
          // codebase is sha256-and-truncate (see `hashIp` above).
          subHash: claims.sub ? hashKeycloakSub(claims.sub) : undefined,
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

function hashKeycloakSub(sub: string): string {
  return createHash("sha256").update(sub).digest("hex").slice(0, 16);
}

type SwitchOrgError = "target_not_found" | "target_archived" | "target_suspended" | "not_a_member";

function switchOrgErrorResponse(error: string): {
  status: number;
  title: string;
  detail: string;
} {
  const table: Record<SwitchOrgError, { status: number; title: string; detail: string }> = {
    target_not_found: { status: 404, title: "Not allowed", detail: "Target tenant not found." },
    target_archived: { status: 404, title: "Not allowed", detail: "Target tenant not found." },
    target_suspended: {
      status: 409,
      title: "Tenant suspended",
      detail: "This tenant is suspended. Contact Givernance support.",
    },
    not_a_member: {
      status: 403,
      title: "Not allowed",
      detail: "You are not a member of this tenant.",
    },
  };
  return (
    table[error as SwitchOrgError] ?? {
      status: 403,
      title: "Not allowed",
      detail: "You are not a member of this tenant.",
    }
  );
}
