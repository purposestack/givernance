/**
 * Support-session API (issue #24).
 *
 * Two coexisting modes — pick at session start. See docs/19-impersonation.md
 * for the operational model and `impersonation-service.ts` for behaviour.
 *
 * Cookie shape:
 *   - On START, we set the impersonation token as `givernance_jwt` cookie
 *     (same name the auth plugin already reads). The web tier swaps cookies
 *     atomically — the operator's normal token is overwritten until END.
 *   - On END, we clear the cookie so the next request bounces to login.
 *     This keeps the impersonation banner from sticking around with a stale
 *     token in flight.
 *
 * Step-up:
 *   - The operator's access token must carry `auth_time` within the last
 *     5 minutes. In production with `IMPERSONATION_REQUIRE_ACR_2=true`,
 *     `acr` must also be `>= 2` (Keycloak's MFA-backed login).
 */

import type { ImpersonationStartBody } from "@givernance/shared/validators";
import {
  ImpersonationSessionSchema,
  ImpersonationStartBodySchema,
  ImpersonationStartResponseSchema,
} from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { requireSuperAdmin } from "../../lib/guards.js";
import {
  clearDeniedAttempts,
  IMPERSONATION_DENIED_LOCKOUT_THRESHOLD,
  IMPERSONATION_MAX_STARTS_PER_24H,
  incrementStartRateLimit,
  isLockedOut,
  recordDeniedAttempt,
} from "../../lib/impersonation/redis-store.js";
import { validateStepUp } from "../../lib/impersonation/step-up.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  endSession,
  getSession,
  getSessionAudit,
  hashIp,
  ImpersonationServiceError,
  listSessions,
  listTenantsForPicker,
  revokeSessionsForTarget,
  searchTargets,
  startSession,
} from "./impersonation-service.js";

const JWT_COOKIE_NAME = "givernance_jwt";
const SessionIdParams = Type.Object({ sessionId: UuidSchema });
const TargetUserIdParams = Type.Object({ targetUserId: UuidSchema });

export async function impersonationRoutes(app: FastifyInstance) {
  /** POST /v1/admin/impersonation — start a new support session (delegation OR impersonation) */
  app.post(
    "/admin/impersonation",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        body: ImpersonationStartBodySchema,
        response: {
          201: DataResponse(ImpersonationStartResponseSchema),
          ...ErrorResponses,
          400: ErrorResponses[404],
          409: ErrorResponses[404],
          423: ErrorResponses[404],
          429: ErrorResponses[404],
        },
      },
    },
    async (request, reply) => {
      const gateResult = await runStartGates(request);
      if (!gateResult.ok) {
        return reply.status(gateResult.status).send(gateResult.body);
      }
      const { auth, operatorAccessToken } = gateResult;

      const body = request.body as ImpersonationStartBody;
      try {
        const result = await startSession({
          impersonatorKeycloakId: auth.userId,
          operatorAccessToken: operatorAccessToken ?? "",
          targetUserId: body.targetUserId,
          mode: body.mode,
          reason: body.reason,
          ipHash: hashIp(request.ip),
          userAgent: request.headers["user-agent"] ?? null,
        });

        await clearDeniedAttempts(auth.userId);
        applyImpersonationCookie(reply, result.token, result.expiresAt);

        return reply.status(201).send({
          data: {
            sessionId: result.sessionId,
            mode: body.mode,
            expiresAt: result.expiresAt.toISOString(),
            token: result.token,
            targetOrgId: result.targetOrgId,
            targetUserId: body.targetUserId,
          },
        });
      } catch (err) {
        if (err instanceof ImpersonationServiceError) {
          return reply
            .status(err.status)
            .send(problemDetail(err.status, mapTitle(err.status), err.message));
        }
        request.log.error({ err }, "impersonation: unexpected start failure");
        throw err;
      }
    },
  );

  /** GET /v1/admin/impersonation — list sessions (active by default; pass ?all=true for full history) */
  app.get(
    "/admin/impersonation",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        querystring: Type.Object({
          all: Type.Optional(Type.Boolean({ default: false })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: {
          200: DataArrayResponseNoPagination(ImpersonationSessionSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const query = request.query as { all?: boolean; limit?: number };
      const sessions = await listSessions({
        activeOnly: !query.all,
        limit: query.limit,
      });
      const now = Date.now();
      return {
        data: sessions.map((s) => ({
          ...s,
          expiresAt: s.expiresAt.toISOString(),
          endedAt: s.endedAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
          isActive: !s.endedAt && s.expiresAt.getTime() > now,
        })),
      };
    },
  );

  /**
   * GET /v1/admin/impersonation/targets — picker-scoped user search for the
   * start-session form. Cross-tenant; excludes platform-tenant members
   * (they can't be impersonated) and soft-deleted users. Matches:
   *   - first/last/email substring (case-insensitive ILIKE)
   *   - exact UUID on `users.id` or `users.keycloak_id`
   * Optional `tenantId` narrows to a single workspace.
   */
  app.get(
    "/admin/impersonation/targets",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 255 })),
          tenantId: Type.Optional(UuidSchema),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
        }),
        response: {
          200: Type.Object({
            data: Type.Array(
              Type.Object({
                id: UuidSchema,
                firstName: Type.String(),
                lastName: Type.String(),
                email: Type.String(),
                role: Type.String(),
                keycloakId: Type.Union([Type.String(), Type.Null()]),
                tenantId: UuidSchema,
                tenantName: Type.String(),
                tenantSlug: Type.String(),
              }),
            ),
          }),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const query = request.query as { q?: string; tenantId?: string; limit?: number };
      const data = await searchTargets(query);
      return { data };
    },
  );

  /**
   * GET /v1/admin/impersonation/tenants — lightweight tenant list for the
   * picker's tenant selector. Smaller surface than `/v1/superadmin/tenants`
   * (no plan / status / domain detail), excludes platform + archived rows.
   */
  app.get(
    "/admin/impersonation/tenants",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 255 })),
        }),
        response: {
          200: Type.Object({
            data: Type.Array(
              Type.Object({
                id: UuidSchema,
                name: Type.String(),
                slug: Type.String(),
                status: Type.String(),
              }),
            ),
          }),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const { q } = request.query as { q?: string };
      const data = await listTenantsForPicker(q);
      return { data };
    },
  );

  /**
   * GET /v1/admin/impersonation/:sessionId/audit — every audit_log row
   * written during a specific session, chronological. Used by the admin
   * detail page to render the timeline of what the operator did under
   * the impersonation cookie. Spec doc-19 §10.
   */
  app.get(
    "/admin/impersonation/:sessionId/audit",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        params: SessionIdParams,
        response: {
          200: Type.Object({
            data: Type.Array(
              Type.Object({
                id: UuidSchema,
                orgId: UuidSchema,
                userId: Type.Union([Type.String(), Type.Null()]),
                actorId: Type.Union([Type.String(), Type.Null()]),
                impersonationMode: Type.Union([Type.String(), Type.Null()]),
                action: Type.String(),
                resourceType: Type.Union([Type.String(), Type.Null()]),
                resourceId: Type.Union([Type.String(), Type.Null()]),
                ipHash: Type.Union([Type.String(), Type.Null()]),
                userAgent: Type.Union([Type.String(), Type.Null()]),
                createdAt: Type.String({ format: "date-time" }),
              }),
            ),
          }),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const session = await getSession(sessionId);
      if (!session) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Impersonation session not found"));
      }
      const data = await getSessionAudit(sessionId);
      return { data };
    },
  );

  /** GET /v1/admin/impersonation/:sessionId — single session detail */
  app.get(
    "/admin/impersonation/:sessionId",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        params: SessionIdParams,
        response: { 200: DataResponse(ImpersonationSessionSchema), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const session = await getSession(sessionId);
      if (!session) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Impersonation session not found"));
      }
      return {
        data: {
          ...session,
          expiresAt: session.expiresAt.toISOString(),
          endedAt: session.endedAt?.toISOString() ?? null,
          createdAt: session.createdAt.toISOString(),
          isActive: !session.endedAt && session.expiresAt.getTime() > Date.now(),
        },
      };
    },
  );

  /**
   * DELETE /v1/admin/impersonation/:sessionId — end a session.
   *
   * Cannot use the standard `requireSuperAdmin` preHandler: pure-impersonation
   * tokens deliberately strip the operator's super_admin role from
   * `roles[]`, so the operator would 404 on their own End-Session button.
   * Instead, accept BOTH:
   *   - a super_admin (for the cross-session revoke flow), or
   *   - an active impersonation token whose `sessionId` matches the URL.
   * Both branches reach the same lookup + audit path below.
   */
  app.delete(
    "/admin/impersonation/:sessionId",
    {
      schema: {
        tags: ["Admin", "Impersonation"],
        params: SessionIdParams,
        response: { 204: Type.Null(), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const guard = checkEndSessionAuth(request);
      if (!guard.ok) return reply.status(guard.status).send(guard.body);

      const { sessionId } = request.params as { sessionId: string };
      const session = await getSession(sessionId);
      if (!session) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Impersonation session not found"));
      }

      // Allow both: (a) the operator ending their OWN active session
      // (regular flow — the banner's "End session" button), and (b) any
      // super_admin revoking ANYONE's session (emergency flow). Use
      // `revoked` for the latter so the audit trail tells them apart.
      const isSelfEnd =
        guard.auth.impersonation?.sessionId === sessionId ||
        session.impersonatorKeycloakId === guard.auth.userId;
      const reason = isSelfEnd ? "manual" : "revoked";

      await endSession({
        sessionId,
        reason,
        byImpersonatorKeycloakId: guard.auth.userId,
        ipHash: hashIp(request.ip),
        userAgent: request.headers["user-agent"] ?? null,
      });

      if (isSelfEnd) applyClearImpersonationCookie(reply);
      return reply.status(204).send();
    },
  );

  /** DELETE /v1/admin/impersonation/user/:targetUserId — revoke ALL active sessions for a user (emergency) */
  app.delete(
    "/admin/impersonation/user/:targetUserId",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Impersonation"],
        params: TargetUserIdParams,
        response: {
          200: Type.Object({ data: Type.Object({ revokedSessionIds: Type.Array(UuidSchema) }) }),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply
          .status(401)
          .send(problemDetail(401, "Unauthorized", "Authentication required."));
      }
      const { targetUserId } = request.params as { targetUserId: string };

      // Resolve the keycloak_id from the app users.id. Anti-enumeration: we
      // ALWAYS return 200 with `revokedSessionIds: []` on a missing target
      // user — distinguishing "user not found" from "user has no sessions"
      // would let a super_admin probe the platform's user UUID space.
      // Reviewer C1.
      const targetKeycloakId = await resolveKeycloakIdForUser(targetUserId);

      if (!targetKeycloakId) {
        return reply.status(200).send({ data: { revokedSessionIds: [] } });
      }

      const revokedSessionIds = await revokeSessionsForTarget({
        targetKeycloakId,
        byImpersonatorKeycloakId: request.auth.userId,
        ipHash: hashIp(request.ip),
        userAgent: request.headers["user-agent"] ?? null,
      });

      return reply.status(200).send({ data: { revokedSessionIds } });
    },
  );
}

type GateOk = {
  ok: true;
  auth: NonNullable<import("fastify").FastifyRequest["auth"]>;
  operatorAccessToken: string | null;
};
type GateFail = { ok: false; status: number; body: ReturnType<typeof problemDetail> };

/**
 * All the pre-flight checks that must pass BEFORE the route inserts a
 * session row. Extracted so the route handler stays under the cognitive-
 * complexity budget — each check still lives next to its sibling logic
 * here rather than smeared across files.
 */
async function runStartGates(
  request: import("fastify").FastifyRequest,
): Promise<GateOk | GateFail> {
  const auth = request.auth;
  if (!auth) {
    return {
      ok: false,
      status: 401,
      body: problemDetail(401, "Unauthorized", "Authentication required."),
    };
  }

  // Block impersonation-from-impersonation: the operator must hold a
  // non-impersonated super_admin session before they can start a new
  // support session, or the audit chain becomes meaningless.
  if (auth.impersonation) {
    return {
      ok: false,
      status: 409,
      body: problemDetail(
        409,
        "Conflict",
        "Cannot start a new impersonation session from inside another impersonation session.",
      ),
    };
  }

  // Lockout check runs BEFORE rate-limit increment so a locked-out
  // operator can't keep burning their daily counter.
  if (await isLockedOut(auth.userId)) {
    return {
      ok: false,
      status: 423,
      body: problemDetail(
        423,
        "Locked",
        `Account temporarily locked after ${IMPERSONATION_DENIED_LOCKOUT_THRESHOLD} failed step-up attempts. Try again later.`,
      ),
    };
  }

  const stepUp = validateStepUp({ auth_time: auth.authTime, acr: auth.acr });
  if (!stepUp.ok) {
    const denied = await recordDeniedAttempt(auth.userId);
    request.log.warn(
      {
        actorId: auth.userId,
        stepUp,
        deniedCount: denied.count,
        audit: "impersonation.denied",
      },
      "impersonation: step-up failed",
    );
    // Extend the RFC 9457 problem detail with two extension members the
    // web side discriminates on (issue #250). `reason` is the machine-
    // readable validateStepUp() outcome — without it, the form can't tell
    // "needs step-up MFA" from a generic 401 (auth missing, cookie expired,
    // etc.) and degrades to a useless toast. `step_up_required` is the
    // hint the form keys off to trigger the Keycloak re-auth redirect with
    // `acr_values=2`. Lockout still wins (no step-up retry available) so
    // we suppress the redirect hint in that case.
    return {
      ok: false,
      status: 401,
      body: problemDetail(
        401,
        "Unauthorized",
        denied.lockedOut
          ? "Step-up authentication failed and account is now locked."
          : "Step-up authentication required — re-authenticate with MFA and retry.",
        {
          // `validateStepUp` always sets `reason` on the failure variant
          // today; the fallback exists so a future regression that
          // returns `{ok:false}` without a reason is visible in logs as
          // a distinct sentinel rather than silently colliding with the
          // generic `step_up_required` boolean. Don't reuse the redirect
          // hint name here — it's a separate signal (review I-2).
          reason: stepUp.reason ?? "unknown_step_up_failure",
          step_up_required: !denied.lockedOut,
        },
      ),
    };
  }

  const rate = await incrementStartRateLimit(auth.userId);
  if (rate.exceeded) {
    return {
      ok: false,
      status: 429,
      body: problemDetail(
        429,
        "Too Many Requests",
        `Impersonation start cap reached: max ${IMPERSONATION_MAX_STARTS_PER_24H} sessions per admin per 24h.`,
      ),
    };
  }

  const operatorAccessToken = extractRawAccessToken(request);
  if (env.IMPERSONATION_USE_KEYCLOAK_EXCHANGE && !operatorAccessToken) {
    return {
      ok: false,
      status: 401,
      body: problemDetail(
        401,
        "Unauthorized",
        "Keycloak Token Exchange path requires the operator's raw access token; none found.",
      ),
    };
  }

  return { ok: true, auth, operatorAccessToken };
}

/**
 * Bespoke auth check for the DELETE endpoint. Standard `requireSuperAdmin`
 * would 404 the operator's own end-session attempt because pure-impersonation
 * tokens deliberately strip the super_admin role. Accept either super_admin
 * OR an active impersonation token whose sessionId matches the URL; record
 * the same `rbacDenial` discriminator the standard guard does so SOC
 * dashboards see probing.
 */
function checkEndSessionAuth(
  request: import("fastify").FastifyRequest,
):
  | { ok: true; auth: NonNullable<import("fastify").FastifyRequest["auth"]> }
  | { ok: false; status: number; body: ReturnType<typeof problemDetail> } {
  if (!request.auth) {
    request.authDenial = { guard: "requireSuperAdmin", reason: "missing_token" };
    return {
      ok: false,
      status: 401,
      body: problemDetail(401, "Unauthorized", "Authentication required."),
    };
  }
  const { sessionId } = request.params as { sessionId: string };
  const isSuperAdmin = request.auth.roles.includes("super_admin");
  const isInsideThisSession = request.auth.impersonation?.sessionId === sessionId;
  if (!isSuperAdmin && !isInsideThisSession) {
    request.rbacDenial = {
      guard: "requireSuperAdmin",
      requiredRoles: ["super_admin"],
      actualRole: request.auth.role ?? null,
    };
    request.log.warn({ rbacDenial: request.rbacDenial }, "rbac denial");
    return { ok: false, status: 404, body: problemDetail(404, "Not Found", "Not Found") };
  }
  return { ok: true, auth: request.auth };
}

/** Clears the impersonation cookie on self-end. Mirrors `applyImpersonationCookie`'s Secure attribute. */
function applyClearImpersonationCookie(reply: import("fastify").FastifyReply): void {
  const isProd = process.env.NODE_ENV === "production";
  reply.header(
    "set-cookie",
    [
      `${JWT_COOKIE_NAME}=`,
      "Path=/",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "HttpOnly",
      "SameSite=Lax",
      isProd ? "Secure" : null,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

/** Sets the impersonation cookie on a successful start. httpOnly + Secure (in prod). */
function applyImpersonationCookie(
  reply: import("fastify").FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const isProd = process.env.NODE_ENV === "production";
  reply.header(
    "set-cookie",
    [
      `${JWT_COOKIE_NAME}=${token}`,
      "Path=/",
      `Max-Age=${ttlSeconds}`,
      "HttpOnly",
      "SameSite=Lax",
      isProd ? "Secure" : null,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

function mapTitle(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 429:
      return "Too Many Requests";
    default:
      return "Error";
  }
}

function extractRawAccessToken(request: {
  headers: Record<string, unknown>;
  cookies?: Record<string, string | undefined>;
}): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return request.cookies?.[JWT_COOKIE_NAME] ?? null;
}

async function resolveKeycloakIdForUser(userId: string): Promise<string | null> {
  // Reuse the systemDb query from the service layer rather than re-importing
  // schema. Inline to avoid an extra service round-trip.
  const { systemDb } = await import("../../lib/db.js");
  const { users } = await import("@givernance/shared/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await systemDb
    .select({ keycloakId: users.keycloakId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.keycloakId ?? null;
}
