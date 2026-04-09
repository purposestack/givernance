/** PostgreSQL Row-Level Security context setter */

import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../lib/db.js";

async function rls(app: FastifyInstance) {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (!request.auth?.orgId) return;

    // Set PostgreSQL session variables for RLS policies
    await db.execute(sql`SET LOCAL app.current_org_id = ${request.auth.orgId}`);
    await db.execute(sql`SET LOCAL app.current_user_id = ${request.auth.userId}`);
  });
}

export const rlsPlugin = fp(rls, {
  name: "rls",
  dependencies: ["auth"],
});
