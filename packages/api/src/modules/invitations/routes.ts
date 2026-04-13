/** Invitation routes — invite users by email, accept via token */

import { invitations, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { requireOrgAdmin } from "../../lib/guards.js";

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

/**
 * Simple in-memory rate limiter for unauthenticated endpoints (M2 fix).
 * Limits per-IP to MAX_ATTEMPTS within WINDOW_MS.
 */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10;
const ipAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    ipAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export async function invitationRoutes(app: FastifyInstance) {
  /**
   * POST /v1/invitations — invite a user by email (org_admin only)
   * Email delivery is Phase 2 — returns the token for now.
   */
  app.post(
    "/invitations",
    { preHandler: requireOrgAdmin, schema: { body: CreateInvitationBody } },
    async (request, reply) => {
      // requireOrgAdmin guarantees auth is non-null
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;
      const body = request.body as { email: string; role?: string };

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
          role: (body.role as "org_admin" | "user" | "viewer") ?? "user",
          invitedById: inviter?.id ?? null,
          expiresAt,
        })
        .returning();

      return reply.status(201).send({ data: invitation });
    },
  );

  /**
   * POST /v1/invitations/:token/accept — accept an invitation (no auth required)
   * The token itself is the credential. Creates a user record in the tenant.
   */
  app.post(
    "/invitations/:token/accept",
    { schema: { body: AcceptInvitationBody } },
    async (request, reply) => {
      // Rate limiting for unauthenticated endpoint (M2 fix)
      if (!checkRateLimit(request.ip)) {
        return reply.status(429).send({
          type: "https://httpproblems.com/http-status/429",
          title: "Too Many Requests",
          status: 429,
          detail: "Rate limit exceeded. Try again later.",
        });
      }

      const { token } = request.params as { token: string };
      const body = request.body as { firstName: string; lastName: string };

      const [invitation] = await db
        .select()
        .from(invitations)
        .where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));

      if (!invitation) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Invalid or already used invitation token",
        });
      }

      if (invitation.expiresAt < new Date()) {
        return reply.status(410).send({
          type: "https://httpproblems.com/http-status/410",
          title: "Gone",
          status: 410,
          detail: "Invitation has expired",
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
    },
  );
}
