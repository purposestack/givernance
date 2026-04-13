/** Invitation routes — invite users by email, accept via token */

import { invitations, users } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../lib/db.js";

const CreateInvitationBody = z.object({
  email: z.string().email(),
  role: z.enum(["org_admin", "user", "viewer"]).default("user"),
});

const AcceptInvitationBody = z.object({
  firstName: z.string().min(1).max(255),
  lastName: z.string().min(1).max(255),
});

/** Guard: require org_admin role */
async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    return reply
      .status(401)
      .send({ statusCode: 401, error: "Unauthorized", message: "Authentication required" });
  }
  if (request.auth.role !== "org_admin") {
    return reply
      .status(403)
      .send({ statusCode: 403, error: "Forbidden", message: "org_admin role required" });
  }
}

export async function invitationRoutes(app: FastifyInstance) {
  /**
   * POST /v1/invitations — invite a user by email (org_admin only)
   * Email delivery is Phase 2 — returns the token for now.
   */
  app.post("/invitations", { preHandler: requireOrgAdmin }, async (request, reply) => {
    // auth is guaranteed non-null by requireOrgAdmin guard
    const { userId, orgId } = request.auth!;
    const body = CreateInvitationBody.parse(request.body);

    // Look up the inviting user's internal ID
    const [inviter] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId)));

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const [invitation] = await db
      .insert(invitations)
      .values({
        orgId,
        email: body.email,
        role: body.role,
        invitedById: inviter?.id ?? null,
        expiresAt,
      })
      .returning();

    return reply.status(201).send({ data: invitation });
  });

  /**
   * POST /v1/invitations/:token/accept — accept an invitation (no auth required)
   * The token itself is the credential. Creates a user record in the tenant.
   */
  app.post("/invitations/:token/accept", async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = AcceptInvitationBody.parse(request.body);

    const [invitation] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));

    if (!invitation) {
      return reply.status(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "Invalid or already used invitation token",
      });
    }

    if (invitation.expiresAt < new Date()) {
      return reply.status(410).send({
        statusCode: 410,
        error: "Gone",
        message: "Invitation has expired",
      });
    }

    const [user] = await db
      .insert(users)
      .values({
        orgId: invitation.orgId,
        email: invitation.email,
        firstName: body.firstName,
        lastName: body.lastName,
        role: invitation.role,
      })
      .returning();

    await db
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, invitation.id));

    return reply.status(201).send({ data: user });
  });
}
