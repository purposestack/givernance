/**
 * Platform-admin CRUD API (issue #254).
 *
 * Endpoints (RBAC: super_admin only — non-super-admins get 404 per
 * `requireSuperAdmin`'s anti-disclosure posture):
 *
 *   GET    /v1/admin/platform-admins                  — list (sort/filter/paginate).
 *   GET    /v1/admin/platform-admins/:id              — detail.
 *   POST   /v1/admin/platform-admins                  — create + KC provisioning + UPDATE_PASSWORD email.
 *   PATCH  /v1/admin/platform-admins/:id              — rename (firstName / lastName).
 *   POST   /v1/admin/platform-admins/:id/reset-password — re-trigger UPDATE_PASSWORD email.
 *   DELETE /v1/admin/platform-admins/:id              — soft-delete + KC user delete + blocklist.
 *
 * Errors are RFC 9457 Problem Details. The service throws typed
 * `PlatformAdminServiceError` instances; this module maps them to HTTP
 * status + a fixed `detail` so test fixtures can lock the body shape
 * (per the project memory "lock RFC 9457 body shape on at least one test
 * per error path").
 *
 * IP + user-agent are hashed/captured for `audit_logs.ip_hash` and
 * `audit_logs.user_agent` so a SOC reviewer can correlate an account
 * change with a specific operator session.
 */

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireSuperAdmin } from "../../lib/guards.js";
import { resolveRequestLocale } from "../../lib/i18n.js";
import { DataResponse, ErrorResponses, problemDetail, UuidSchema } from "../../lib/schemas.js";
import { hashIp } from "./impersonation-service.js";
import {
  acceptPlatformAdminInvitation,
  getPlatformAdminById,
  getPlatformAdminInvitationByToken,
  invitePlatformAdmin,
  listPlatformAdmins,
  PLATFORM_ADMIN_SORT_FIELDS,
  PlatformAdminServiceError,
  type PlatformAdminSortField,
  type PlatformAdminSortOrder,
  resetPlatformAdminPassword,
  softDeletePlatformAdmin,
  updatePlatformAdminName,
} from "./platform-admins-service.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const PlatformAdminIdParams = Type.Object({ id: UuidSchema });

const SortFieldSchema = Type.Union(PLATFORM_ADMIN_SORT_FIELDS.map((v) => Type.Literal(v)));
const SortOrderSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);

const ListQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 255 })),
  includeDeleted: Type.Optional(Type.Boolean({ default: false })),
  sort: Type.Optional(SortFieldSchema),
  order: Type.Optional(SortOrderSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

const PlatformAdminSchema = Type.Object({
  id: UuidSchema,
  keycloakId: Type.Union([Type.String(), Type.Null()]),
  email: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const ListResponse = Type.Object({
  data: Type.Array(PlatformAdminSchema),
  meta: Type.Object({
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  }),
});

const CreateBody = Type.Object({
  email: Type.String({ format: "email", minLength: 3, maxLength: 255 }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
});

const UpdateBody = Type.Object(
  {
    firstName: Type.String({ minLength: 1, maxLength: 255 }),
    lastName: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { minProperties: 1, additionalProperties: false },
);

const InvitationSummarySchema = Type.Object({
  invitationId: UuidSchema,
  email: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  expiresAt: Type.String(),
});

/**
 * Public invitation read shape — surfaces only what the accept page needs
 * to render. NEVER returns the token itself or any internal-id fields.
 */
const PublicInvitationSchema = Type.Object({
  email: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  expiresAt: Type.String(),
});

const AcceptBody = Type.Object({
  password: Type.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function serialize(row: {
  id: string;
  keycloakId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    keycloakId: row.keycloakId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapErrorToProblem(err: PlatformAdminServiceError) {
  return problemDetail(err.status, mapTitle(err.status), err.message);
}

function mapTitle(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 502) return "Bad Gateway";
  return "Error";
}

function actorContext(request: FastifyRequest) {
  return {
    actorKeycloakId: request.auth?.userId ?? "",
    ipHash: hashIp(request.ip),
    userAgent: request.headers["user-agent"] ?? null,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function platformAdminsRoutes(app: FastifyInstance) {
  /** GET /v1/admin/platform-admins — list with sort/filter/paginate */
  app.get(
    "/admin/platform-admins",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Platform Admins"],
        querystring: ListQuery,
        response: {
          200: ListResponse,
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const q = request.query as {
        q?: string;
        includeDeleted?: boolean;
        sort?: PlatformAdminSortField;
        order?: PlatformAdminSortOrder;
        limit?: number;
        offset?: number;
      };
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const result = await listPlatformAdmins({
        q: q.q,
        includeDeleted: q.includeDeleted ?? false,
        sort: q.sort ?? "createdAt",
        order: q.order ?? "desc",
        limit,
        offset,
      });
      return {
        data: result.rows.map(serialize),
        meta: { total: result.total, limit, offset },
      };
    },
  );

  /** GET /v1/admin/platform-admins/:id — detail */
  app.get(
    "/admin/platform-admins/:id",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Platform Admins"],
        params: PlatformAdminIdParams,
        response: {
          200: DataResponse(PlatformAdminSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await getPlatformAdminById(id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Platform admin not found."));
      }
      return { data: serialize(row) };
    },
  );

  /**
   * POST /v1/admin/platform-admins — issue an invitation.
   *
   * Post fix-commit-4 refactor (PR #253): no longer creates the KC user
   * synchronously. Inserts an invitations row + outbox event; the worker
   * sends the email; the invitee accepts on the public page which then
   * does the KC create + role + Org + platform_admins insert.
   *
   * Response shape: returns the invitation id + email + expiresAt so the
   * UI can render "invitation sent" without leaking identity-surface
   * state before the invitee accepts.
   */
  app.post(
    "/admin/platform-admins",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Platform Admins"],
        body: CreateBody,
        response: {
          201: DataResponse(InvitationSummarySchema),
          ...ErrorResponses,
          409: ErrorResponses[404],
          502: ErrorResponses[404],
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; firstName: string; lastName: string };
      try {
        const result = await invitePlatformAdmin({
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          ...actorContext(request),
          // Invite email picks up the operator's locale — best signal
          // for the invitee's language until they accept and pick their
          // own (which then writes the KC `locale` user attribute).
          locale: resolveRequestLocale(request),
        });
        return reply.status(201).send({
          data: {
            invitationId: result.invitationId,
            email: result.email,
            firstName: result.firstName,
            lastName: result.lastName,
            expiresAt: result.expiresAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof PlatformAdminServiceError) {
          return reply.status(err.status).send(mapErrorToProblem(err));
        }
        request.log.error({ err }, "platform-admins: invite failed");
        throw err;
      }
    },
  );

  // ─── Public accept flow ──────────────────────────────────────────────────
  //
  // Two public routes — no JWT required — that handle the invitee's
  // session-conflict-friendly acceptance. The web app's
  // `/admin/platform-admins/accept?token=...` page reads from these.
  //
  // Anti-enumeration: every state that isn't "pending + unaccepted +
  // unexpired" returns 404 with the same body. The token itself is the
  // capability — a valid token reveals invitee email + name; an invalid
  // one reveals nothing.

  /** GET /v1/public/platform-admins/invitations/:token — read invitation */
  app.get(
    "/public/platform-admins/invitations/:token",
    {
      schema: {
        tags: ["Public", "Platform Admins"],
        params: Type.Object({ token: Type.String({ format: "uuid" }) }),
        response: {
          200: DataResponse(PublicInvitationSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const invite = await getPlatformAdminInvitationByToken(token);
      if (!invite) {
        return reply
          .status(404)
          .send(
            problemDetail(404, "Not Found", "Invitation not found, expired, or already accepted."),
          );
      }
      return {
        data: {
          email: invite.email,
          firstName: invite.firstName,
          lastName: invite.lastName,
          expiresAt: invite.expiresAt.toISOString(),
        },
      };
    },
  );

  /** POST /v1/public/platform-admins/invitations/:token/accept — accept + provision KC */
  app.post(
    "/public/platform-admins/invitations/:token/accept",
    {
      schema: {
        tags: ["Public", "Platform Admins"],
        params: Type.Object({ token: Type.String({ format: "uuid" }) }),
        body: AcceptBody,
        response: {
          201: DataResponse(PlatformAdminSchema),
          ...ErrorResponses,
          409: ErrorResponses[404],
          502: ErrorResponses[404],
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const body = request.body as { password: string; firstName: string; lastName: string };
      try {
        const row = await acceptPlatformAdminInvitation({
          token,
          password: body.password,
          firstName: body.firstName,
          lastName: body.lastName,
          ipHash: hashIp(request.ip),
          userAgent: request.headers["user-agent"] ?? null,
          // Invitee's accept-page locale → KC `locale` user attribute, so
          // future built-in flows (e.g. UPDATE_PASSWORD via reset) honour
          // their language without the operator having to set it manually.
          locale: resolveRequestLocale(request),
        });
        return reply.status(201).send({ data: serialize(row) });
      } catch (err) {
        if (err instanceof PlatformAdminServiceError) {
          return reply.status(err.status).send(mapErrorToProblem(err));
        }
        request.log.error({ err }, "platform-admins: accept failed");
        throw err;
      }
    },
  );

  /** PATCH /v1/admin/platform-admins/:id — rename */
  app.patch(
    "/admin/platform-admins/:id",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Platform Admins"],
        params: PlatformAdminIdParams,
        body: UpdateBody,
        response: {
          200: DataResponse(PlatformAdminSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { firstName: string; lastName: string };
      try {
        const row = await updatePlatformAdminName({
          id,
          firstName: body.firstName,
          lastName: body.lastName,
          ...actorContext(request),
        });
        return { data: serialize(row) };
      } catch (err) {
        if (err instanceof PlatformAdminServiceError) {
          return reply.status(err.status).send(mapErrorToProblem(err));
        }
        request.log.error({ err }, "platform-admins: rename failed");
        throw err;
      }
    },
  );

  /** POST /v1/admin/platform-admins/:id/reset-password — re-send password reset email */
  app.post(
    "/admin/platform-admins/:id/reset-password",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Platform Admins"],
        params: PlatformAdminIdParams,
        response: {
          204: Type.Null(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        await resetPlatformAdminPassword({
          id,
          ...actorContext(request),
        });
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof PlatformAdminServiceError) {
          return reply.status(err.status).send(mapErrorToProblem(err));
        }
        request.log.error({ err }, "platform-admins: reset-password failed");
        throw err;
      }
    },
  );

  /** DELETE /v1/admin/platform-admins/:id — soft-delete + KC delete + blocklist */
  app.delete(
    "/admin/platform-admins/:id",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin", "Platform Admins"],
        params: PlatformAdminIdParams,
        response: {
          204: Type.Null(),
          ...ErrorResponses,
          400: ErrorResponses[404],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        await softDeletePlatformAdmin({
          id,
          ...actorContext(request),
        });
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof PlatformAdminServiceError) {
          return reply.status(err.status).send(mapErrorToProblem(err));
        }
        request.log.error({ err }, "platform-admins: soft-delete failed");
        throw err;
      }
    },
  );
}
