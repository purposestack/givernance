/**
 * Provisional-admin dispute routes (issue #113 / ADR-016 / doc 22 §3.1, §4.3).
 *
 *  - `POST /v1/tenants/:orgId/admin-dispute`    — tenant member (not first_admin).
 *  - `GET  /v1/admin/disputes`                  — super-admin list.
 *  - `GET  /v1/admin/disputes/:id`              — super-admin detail.
 *  - `PATCH /v1/admin/disputes/:id`             — super-admin resolves.
 */

import { createHash } from "node:crypto";
import { TENANT_ADMIN_DISPUTE_RESOLUTION_VALUES } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth, requireSuperAdmin } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { getDispute, listDisputes, openDispute, resolveDispute } from "./service.js";

const TenantOrgIdParams = Type.Object({ orgId: UuidSchema });
const DisputeIdParams = Type.Object({ id: UuidSchema });

const DisputeOpenBody = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

const DisputeOpenResponse = Type.Object({
  disputeId: UuidSchema,
});

const DisputeRowSchema = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  orgSlug: Type.String(),
  orgName: Type.String(),
  disputerId: Type.Union([UuidSchema, Type.Null()]),
  provisionalAdminId: Type.Union([UuidSchema, Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  resolution: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

const DisputeListQuery = Type.Object({
  open: Type.Optional(Type.Boolean()),
});

const DisputeResolveBody = Type.Object({
  resolution: Type.Union(TENANT_ADMIN_DISPUTE_RESOLUTION_VALUES.map((v) => Type.Literal(v))),
});

const DisputeResolveResponse = Type.Object({
  resolution: Type.String(),
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

export async function disputeRoutes(app: FastifyInstance) {
  /** POST /v1/tenants/:orgId/admin-dispute — any tenant member (not first_admin). */
  app.post(
    "/tenants/:orgId/admin-dispute",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: {
        tags: ["Disputes"],
        params: TenantOrgIdParams,
        body: DisputeOpenBody,
        response: {
          201: DataResponse(DisputeOpenResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const body = request.body as { reason?: string };
      const authClaims = request.auth;
      if (!authClaims) {
        return reply
          .status(401)
          .send(problemDetail(401, "Unauthorized", "Authentication required."));
      }
      // Only members of the same tenant can dispute.
      if (authClaims.orgId !== orgId) {
        return reply
          .status(403)
          .send(problemDetail(403, "Forbidden", "You are not a member of this tenant."));
      }

      const res = await openDispute({
        orgId,
        disputerKeycloakSub: authClaims.userId,
        reason: body.reason,
        audit: audit(request),
      });

      if (!res.ok) {
        const status =
          res.error === "tenant_not_found" || res.error === "not_a_member"
            ? 404
            : res.error === "window_closed"
              ? 422
              : res.error === "is_first_admin"
                ? 403
                : 409;
        return reply
          .status(status)
          .send(
            problemDetail(
              status,
              describeDisputeError(res.error),
              describeDisputeErrorDetail(res.error),
            ),
          );
      }

      return reply.status(201).send({ data: { disputeId: res.disputeId } });
    },
  );

  /** GET /v1/admin/disputes — super-admin triage queue. */
  app.get(
    "/admin/disputes",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Disputes"],
        querystring: DisputeListQuery,
        response: {
          200: DataArrayResponseNoPagination(DisputeRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { open?: boolean };
      const rows = await listDisputes({ open: query.open });
      return reply.send({ data: rows });
    },
  );

  /** GET /v1/admin/disputes/:id — super-admin detail. */
  app.get(
    "/admin/disputes/:id",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Disputes"],
        params: DisputeIdParams,
        response: {
          200: DataResponse(DisputeRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await getDispute(id);
      if (!row)
        return reply.status(404).send(problemDetail(404, "Not Found", "Dispute not found."));
      return reply.send({ data: row });
    },
  );

  /** PATCH /v1/admin/disputes/:id — super-admin resolution. */
  app.patch(
    "/admin/disputes/:id",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Disputes"],
        params: DisputeIdParams,
        body: DisputeResolveBody,
        response: {
          200: DataResponse(DisputeResolveResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { resolution: "kept" | "replaced" | "escalated_to_support" };
      const authClaims = request.auth;
      if (!authClaims) {
        return reply
          .status(401)
          .send(problemDetail(401, "Unauthorized", "Authentication required."));
      }

      const res = await resolveDispute({
        disputeId: id,
        resolution: body.resolution,
        resolverUserKeycloakSub: authClaims.userId,
        audit: audit(request),
      });

      if (!res.ok) {
        const status =
          res.error === "not_found" ? 404 : res.error === "already_resolved" ? 409 : 422;
        return reply
          .status(status)
          .send(
            problemDetail(
              status,
              res.error === "not_found"
                ? "Not Found"
                : res.error === "already_resolved"
                  ? "Already resolved"
                  : "Cannot resolve",
              res.error === "not_found"
                ? "Dispute not found."
                : res.error === "already_resolved"
                  ? "This dispute has already been resolved."
                  : "Dispute record is missing one of the users required for this resolution.",
            ),
          );
      }

      return reply.send({ data: { resolution: res.resolution } });
    },
  );
}

function describeDisputeError(error: string): string {
  if (error === "tenant_not_found") return "Not Found";
  if (error === "not_a_member") return "Not Found";
  if (error === "is_first_admin") return "Forbidden";
  if (error === "window_closed") return "Dispute window closed";
  return "Already disputed";
}

function describeDisputeErrorDetail(error: string): string {
  switch (error) {
    case "tenant_not_found":
    case "not_a_member":
      return "Tenant not found or you are not a member.";
    case "is_first_admin":
      return "The provisional admin cannot dispute themselves.";
    case "window_closed":
      return "The 7-day provisional-admin dispute window has closed.";
    case "already_disputed":
      return "A dispute for this tenant is already open.";
    default:
      return "Could not open the dispute.";
  }
}
