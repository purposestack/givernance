/** User routes — user profile and org-admin user management */

import { outboxEvents, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";

const CreateUserBody = Type.Object({
  email: Type.String({ format: "email" }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  role: Type.Optional(
    Type.Union([Type.Literal("org_admin"), Type.Literal("user"), Type.Literal("viewer")]),
  ),
});

const UpdateRoleBody = Type.Object({
  role: Type.Union([Type.Literal("org_admin"), Type.Literal("user"), Type.Literal("viewer")]),
});

export async function userRoutes(app: FastifyInstance) {
  /** GET /v1/users/me — current user profile (requires JWT) */
  app.get("/users/me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.auth?.userId as string;
    const orgId = request.auth?.orgId as string;

    const user = await withTenantContext(orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(users)
        .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId)));
      return row;
    });

    if (!user) {
      return reply.status(404).send({
        type: "https://httpproblems.com/http-status/404",
        title: "Not Found",
        status: 404,
        detail: "User profile not found",
      });
    }

    return reply.send({ data: user });
  });

  /** GET /v1/users — list users in tenant (org_admin only) */
  app.get("/users", { preHandler: requireOrgAdmin }, async (request, reply) => {
    const orgId = request.auth?.orgId as string;
    const all = await withTenantContext(orgId, async (tx) => {
      return tx.select().from(users).where(eq(users.orgId, orgId));
    });
    return reply.send({ data: all });
  });

  /** POST /v1/users — create user in tenant (org_admin only) */
  app.post(
    "/users",
    { preHandler: requireOrgAdmin, schema: { body: CreateUserBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const body = request.body as {
        email: string;
        firstName: string;
        lastName: string;
        role?: string;
      };

      // withTenantContext already wraps in a transaction — use tx for outbox pattern
      const result = await withTenantContext(orgId, async (tx) => {
        const [inserted] = await tx
          .insert(users)
          .values({
            ...body,
            role: (body.role as "org_admin" | "user" | "viewer") ?? "user",
            orgId,
          })
          .returning();

        // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row for single insert
        const user = inserted!;
        await tx.insert(outboxEvents).values({
          tenantId: orgId,
          type: "user.created",
          payload: { userId: user.id, email: user.email, orgId },
        });

        return user;
      });

      return reply.status(201).send({ data: result });
    },
  );

  /** PATCH /v1/users/:id/role — update user role (org_admin only) */
  app.patch(
    "/users/:id/role",
    { preHandler: requireOrgAdmin, schema: { body: UpdateRoleBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as { role: "org_admin" | "user" | "viewer" };

      const updated = await withTenantContext(orgId, async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ role: body.role, updatedAt: new Date() })
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .returning();
        return row;
      });

      if (!updated) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "User not found",
        });
      }

      return reply.send({ data: updated });
    },
  );

  /** DELETE /v1/users/:id — remove user from tenant (org_admin only) */
  app.delete("/users/:id", { preHandler: requireOrgAdmin }, async (request, reply) => {
    const orgId = request.auth?.orgId as string;
    const { id } = request.params as { id: string };

    const deleted = await withTenantContext(orgId, async (tx) => {
      const [row] = await tx
        .delete(users)
        .where(and(eq(users.id, id), eq(users.orgId, orgId)))
        .returning();
      return row;
    });

    if (!deleted) {
      return reply.status(404).send({
        type: "https://httpproblems.com/http-status/404",
        title: "Not Found",
        status: 404,
        detail: "User not found",
      });
    }

    return reply.status(200).send({ data: deleted });
  });
}
