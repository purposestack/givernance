/** PostgreSQL Row-Level Security context setter */

import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../lib/db.js";

/** Validate UUID format to prevent injection in SET LOCAL (which cannot use $1 params) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rls(app: FastifyInstance) {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (!request.auth?.orgId) return;

    const { orgId, userId } = request.auth;

    // SET LOCAL does not support parameterized queries — validate UUIDs to prevent injection
    if (!UUID_RE.test(orgId) || !UUID_RE.test(userId)) return;

    await db.execute(sql.raw(`SET LOCAL app.current_org_id = '${orgId}'`));
    await db.execute(sql.raw(`SET LOCAL app.current_user_id = '${userId}'`));
  });
}

export const rlsPlugin = fp(rls, {
  name: "rls",
  dependencies: ["auth"],
});
