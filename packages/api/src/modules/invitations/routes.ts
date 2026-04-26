/**
 * Team invitation routes (issue #145).
 *
 * - `POST   /v1/invitations`               — org_admin creates an invite
 * - `GET    /v1/invitations`               — org_admin lists pending/accepted
 * - `POST   /v1/invitations/:id/resend`    — rotate token, re-emit email
 * - `DELETE /v1/invitations/:id`           — revoke a pending invite
 * - `GET    /v1/invitations/:token/probe`  — public, side-effect-free check
 * - `POST   /v1/invitations/:token/accept` — public, token = credential
 *
 * The accept endpoint mirrors the structural twin in `signup/routes.ts`:
 * all failure modes collapse to a single 410 generic to remove the
 * status-code enumeration oracle. The service-side `log.warn` already
 * emits a structured `event` discriminator (`team_invite.kc_user_exists`,
 * etc.) that SRE can grep.
 */

import { createHash } from "node:crypto";
import { SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  acceptTeamInvitation,
  createTeamInvitation,
  listTeamInvitations,
  probeTeamInvitation,
  resendTeamInvitation,
  revokeTeamInvitation,
} from "./service.js";

const LocaleSchema = Type.Union(SUPPORTED_LOCALES.map((value) => Type.Literal(value)));

// ─── Schemas ────────────────────────────────────────────────────────────────

const RoleSchema = Type.Union([
  Type.Literal("org_admin"),
  Type.Literal("user"),
  Type.Literal("viewer"),
]);

const CreateInvitationBody = Type.Object({
  email: Type.String({ format: "email", maxLength: 255 }),
  role: Type.Optional(RoleSchema),
});

const AcceptInvitationBody = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  /**
   * Cleartext password the invitee picks. Min 12 to comply with the
   * realm's brute-force protection without leaking exact policy back to
   * the frontend (matches the signup verify endpoint).
   */
  password: Type.String({ minLength: 12, maxLength: 128 }),
  /**
   * Optional BCP-47 locale picked at acceptance (issue #153). Persisted
   * to `users.locale` only when it differs from the tenant's
   * `default_locale`; accepting the default leaves `users.locale` NULL.
   */
  locale: Type.Optional(LocaleSchema),
});

const TokenParams = Type.Object({ token: UuidSchema });

const InvitationResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  email: Type.String(),
  role: RoleSchema,
  invitedById: Type.Union([Type.Null(), UuidSchema]),
  acceptedAt: Type.Union([Type.Null(), Type.String()]),
  expiresAt: Type.String(),
  createdAt: Type.String(),
});

const InvitationListItem = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  email: Type.String(),
  role: RoleSchema,
  invitedById: Type.Union([Type.Null(), UuidSchema]),
  /**
   * Display name of the inviter ("First Last"). Null when the inviter
   * row was deleted (FK ON DELETE SET NULL) or when the invitation was
   * created by the super-admin seeding path with `invitedById = null`.
   */
  invitedByName: Type.Union([Type.Null(), Type.String()]),
  acceptedAt: Type.Union([Type.Null(), Type.String()]),
  expiresAt: Type.String(),
  createdAt: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("expired")]),
});

const AcceptResponse = Type.Object({
  /** Tenant slug — drives the post-accept Keycloak login `?hint=` param. */
  slug: Type.String(),
});

/**
 * Probe success response. Carries the tenant's `default_locale` so the
 * accept form can pre-select the right locale picker option (issue #153).
 * Failure paths still collapse to a generic 410 — anti-enumeration.
 */
const ProbeResponse = Type.Object({
  tenantDefaultLocale: LocaleSchema,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function clientIp(request: FastifyRequest): string | undefined {
  return request.ip ?? undefined;
}

function userAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 512) : undefined;
}

function serializeInvitation(row: {
  id: string;
  orgId: string;
  email: string;
  role: string;
  invitedById: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role,
    invitedById: row.invitedById,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function invitationRoutes(app: FastifyInstance) {
  /** POST /v1/invitations — invite a teammate (org_admin only). */
  app.post(
    "/invitations",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Invitations"],
        body: CreateInvitationBody,
        response: {
          201: DataResponse(InvitationResponse),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;
      const body = request.body as { email: string; role?: "org_admin" | "user" | "viewer" };

      const result = await createTeamInvitation({
        orgId,
        email: body.email,
        role: body.role,
        inviterKeycloakId: userId,
        ipHash: hashIp(clientIp(request)),
        userAgent: userAgent(request),
      });

      if (!result.ok) {
        const detail =
          result.error.kind === "already_member"
            ? "This email already belongs to a member of your organisation."
            : "An invitation for this email is already pending. Resend it instead.";
        return reply.status(409).send(problemDetail(409, "Conflict", detail));
      }

      return reply.status(201).send({ data: serializeInvitation(result.data) });
    },
  );

  /** GET /v1/invitations — list invitations for the current tenant (org_admin only). */
  app.get(
    "/invitations",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Invitations"],
        querystring: PaginationQuery,
        response: {
          200: DataArrayResponse(InvitationListItem),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const query = request.query as { page?: number; perPage?: number };
      const result = await listTeamInvitations({
        orgId,
        page: query.page,
        perPage: query.perPage,
      });

      return reply.status(200).send({
        data: result.data.map((row) => ({
          ...serializeInvitation(row),
          invitedByName: row.invitedByName,
          status: row.status,
        })),
        pagination: result.pagination,
      });
    },
  );

  /**
   * POST /v1/invitations/:id/resend — rotate token and re-emit email.
   *
   * Per-invitation rate limiting protects against an admin accidentally
   * spamming a single invitee — the service rotates the token on every
   * call, so a tight loop here would invalidate just-delivered links.
   */
  app.post(
    "/invitations/:id/resend",
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Invitations"],
        params: IdParams,
        response: {
          204: Type.Null(),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;
      const { id } = request.params as { id: string };

      const result = await resendTeamInvitation({
        orgId,
        invitationId: id,
        actorKeycloakId: userId,
        ipHash: hashIp(clientIp(request)),
        userAgent: userAgent(request),
      });

      if (!result.ok) {
        if (result.error === "not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Invitation not found."));
        }
        return reply
          .status(409)
          .send(problemDetail(409, "Conflict", "This invitation has already been accepted."));
      }

      return reply.status(204).send();
    },
  );

  /** DELETE /v1/invitations/:id — revoke a pending invitation (org_admin only). */
  app.delete(
    "/invitations/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Invitations"],
        params: IdParams,
        response: {
          204: Type.Null(),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;
      const { id } = request.params as { id: string };

      const result = await revokeTeamInvitation({
        orgId,
        invitationId: id,
        actorKeycloakId: userId,
        ipHash: hashIp(clientIp(request)),
        userAgent: userAgent(request),
      });

      if (!result.ok) {
        if (result.error === "not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Invitation not found."));
        }
        return reply
          .status(409)
          .send(
            problemDetail(
              409,
              "Conflict",
              "This invitation has already been accepted and cannot be revoked.",
            ),
          );
      }

      return reply.status(204).send();
    },
  );

  /**
   * GET /v1/invitations/:token/probe — public side-effect-free token check.
   *
   * Returns `204` if the token is valid + pending + unexpired, `410` for
   * everything else. Used by the /invite/accept page to short-circuit dead
   * links to the terminal error screen on page load (PR #154 follow-up).
   *
   * Anti-enumeration: every failure mode collapses to the same 410 the
   * accept endpoint uses — no information about whether the row exists,
   * was accepted, expired, or has the wrong purpose leaks back.
   *
   * Rate-limited tighter than accept (30 req / 15min per IP) because this
   * is read-only and bot-friendly: a generous limit would let an attacker
   * brute-force UUIDs cheaply. Client-side, the probe is invoked exactly
   * once per page load; legitimate humans never hit the cap.
   */
  app.get(
    "/invitations/:token/probe",
    {
      schema: {
        tags: ["Invitations"],
        params: TokenParams,
        response: {
          // Issue #153: response moved from 204 → 200 with a body so the
          // accept form can read the tenant's default_locale on page load.
          // The web client treats both 200 (with body) and 204 (legacy) as
          // "valid" so a stale browser cache during deploy doesn't break;
          // see InvitationService.probeInvitation.
          200: DataResponse(ProbeResponse),
          410: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const result = await probeTeamInvitation(token);
      if (!result) {
        request.log.info({ event: "team_invite.probe_rejected" }, "probe rejected");
        return reply
          .status(410)
          .send(
            problemDetail(
              410,
              "Invitation expired",
              "This invitation link is invalid or has already been used. Ask the person who invited you to send a new one.",
            ),
          );
      }
      return reply.status(200).send({
        data: { tenantDefaultLocale: result.tenantDefaultLocale },
      });
    },
  );

  /**
   * POST /v1/invitations/:token/accept — public accept endpoint.
   *
   * The token IS the security boundary. All failure modes collapse to a
   * generic 410 (no enumeration oracle); SRE breadcrumbs come from the
   * service-side warn log.
   */
  app.post(
    "/invitations/:token/accept",
    {
      schema: {
        tags: ["Invitations"],
        params: TokenParams,
        body: AcceptInvitationBody,
        response: {
          201: DataResponse(AcceptResponse),
          400: ProblemDetailSchema,
          410: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const body = request.body as {
        firstName: string;
        lastName: string;
        password: string;
        locale?: "en" | "fr";
      };

      const result = await acceptTeamInvitation({
        token,
        firstName: body.firstName,
        lastName: body.lastName,
        password: body.password,
        locale: body.locale,
        ipHash: hashIp(clientIp(request)),
        userAgent: userAgent(request),
      });

      if (!result.ok) {
        request.log.info({ event: "team_invite.accept_rejected" }, "accept rejected");
        return reply
          .status(410)
          .send(
            problemDetail(
              410,
              "Invitation expired",
              "This invitation link is invalid or has already been used. Ask the person who invited you to send a new one.",
            ),
          );
      }

      return reply.status(201).send({ data: { slug: result.slug } });
    },
  );
}
