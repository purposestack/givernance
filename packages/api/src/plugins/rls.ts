/** PostgreSQL Row-Level Security context setter */

import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../lib/db.js";

/** Validate UUID format to prevent injection */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rls(app: FastifyInstance) {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (!request.auth?.orgId) return;

    const { orgId, userId } = request.auth;

    if (!UUID_RE.test(orgId) || !UUID_RE.test(userId)) return;

    // Session-scoped (false) so the setting persists across queries within the request lifecycle.
    // Transaction-scoped (true) was lost immediately because Drizzle creates new transactions. (B1 fix)
    await db.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, false)`);
    await db.execute(sql`SELECT set_config('app.current_user_id', ${userId}, false)`);
  });

  // Reset session-scoped settings on response so pooled connections don't leak tenant context (B1 fix)
  app.addHook("onResponse", async (request) => {
    if (request.auth?.orgId) {
      await db.execute(sql`SELECT set_config('app.current_org_id', '', false)`);
      await db.execute(sql`SELECT set_config('app.current_user_id', '', false)`);
    }
  });
}

export const rlsPlugin = fp(rls, {
  name: "rls",
  dependencies: ["auth"],
});
