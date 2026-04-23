/**
 * Org-picker + switch-org routes (issue #112 / ADR-016 / doc 22 §6.3).
 *
 *  - `GET /v1/users/me/organizations` — cards for the picker.
 *  - `POST /v1/session/switch-org`    — validate + record + blocklist.
 *
 * The `GET /v1/users/me` endpoint stays in the `users` module; only the
 * multi-tenant listing lives here so the `me` response is not bloated.
 */

import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { listUserOrganizations, recordOrgSwitch } from "./service.js";

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
        const status =
          res.error === "target_not_found"
            ? 404
            : res.error === "target_archived"
              ? 404
              : res.error === "target_suspended"
                ? 409
                : 403;
        return reply
          .status(status)
          .send(
            problemDetail(
              status,
              res.error === "target_suspended" ? "Tenant suspended" : "Not allowed",
              res.error === "target_suspended"
                ? "This tenant is suspended. Contact Givernance support."
                : res.error === "not_a_member"
                  ? "You are not a member of this tenant."
                  : "Target tenant not found.",
            ),
          );
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
}
