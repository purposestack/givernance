/** Admin impersonation routes — manage impersonation sessions (super_admin only) */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireSuperAdmin } from "../../lib/guards.js";
import { ErrorResponses, UuidSchema } from "../../lib/schemas.js";

const SessionIdParams = Type.Object({ sessionId: UuidSchema });

export async function impersonationRoutes(app: FastifyInstance) {
  /** DELETE /admin/impersonation/:sessionId — end an impersonation session (super_admin only) */
  app.delete(
    "/admin/impersonation/:sessionId",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin"],
        params: SessionIdParams,
        response: { 204: Type.Null(), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };

      // Phase 2: look up session in Redis and validate ownership
      // For now, log the session termination and clear the JWT cookie
      request.log.info(
        { sessionId, actor: request.auth?.userId },
        "Impersonation session terminated",
      );

      return reply
        .header(
          "set-cookie",
          "token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax",
        )
        .status(204)
        .send();
    },
  );
}
