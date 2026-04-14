/** Invitation routes — invite users by email, accept via token */

import { invitations, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, withTenantContext } from "../../lib/db.js";
import { requireOrgAdmin } from "../../lib/guards.js";
import {
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";

const CreateInvitationBody = Type.Object({
  email: Type.String({ format: "email" }),
  role: Type.Optional(
    Type.Union([Type.Literal("org_admin"), Type.Literal("user"), Type.Literal("viewer")]),
  ),
});

const AcceptInvitationBody = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
});

const InvitationResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  email: Type.String(),
  role: Type.String(),
  token: Type.String(),
  invitedById: Type.Union([UuidSchema, Type.Null()]),
  acceptedAt: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.String(),
  createdAt: Type.String(),
});

const AcceptedUserResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  email: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  role: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export async function invitationRoutes(app: FastifyInstance) {
  /**
   * POST /v1/invitations — invite a user by email (org_admin only)
   * Email delivery is Phase 2 — returns the token for now.
   */
  app.post(
    "/invitations",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Invitations"],
        body: CreateInvitationBody,
        response: { 201: DataResponse(InvitationResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;
      const body = request.body as { email: string; role?: string };

      const invitation = await withTenantContext(orgId, async (tx) => {
        const [inviter] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId)));

        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const [row] = await tx
          .insert(invitations)
          .values({
            orgId,
            email: body.email,
            role: (body.role as "org_admin" | "user" | "viewer") ?? "user",
            invitedById: inviter?.id ?? null,
            expiresAt,
          })
          .returning();

        return row;
      });

      return reply.status(201).send({ data: invitation });
    },
  );

  /**
   * POST /v1/invitations/:token/accept — accept an invitation (no auth required)
   * The token itself is the credential. Creates a user record in the tenant.
   *
   * Invitation lookup uses `db` directly (no tenant context) because this endpoint
   * is unauthenticated and the orgId isn't known until the invitation is found.
   * FORCE RLS is intentionally omitted on invitations for this reason.
   * Writes to users/invitations then use withTenantContext for RLS compliance.
   */
  app.post(
    "/invitations/:token/accept",
    {
      schema: {
        tags: ["Invitations"],
        body: AcceptInvitationBody,
        response: {
          201: DataResponse(AcceptedUserResponse),
          410: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const body = request.body as { firstName: string; lastName: string };

      // Step 1: Look up invitation without tenant context (no FORCE RLS on invitations)
      const [invitation] = await db
        .select()
        .from(invitations)
        .where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));

      if (!invitation) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Invalid or already used invitation token"));
      }

      if (invitation.expiresAt < new Date()) {
        return reply.status(410).send(problemDetail(410, "Gone", "Invitation has expired"));
      }

      // Step 2: Create user and mark invitation accepted within tenant context
      const user = await withTenantContext(invitation.orgId, async (tx) => {
        const [newUser] = await tx
          .insert(users)
          .values({
            orgId: invitation.orgId,
            email: invitation.email,
            firstName: body.firstName,
            lastName: body.lastName,
            role: invitation.role,
          })
          .returning();

        await tx
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(invitations.id, invitation.id));

        return newUser;
      });

      return reply.status(201).send({ data: user });
    },
  );
}
