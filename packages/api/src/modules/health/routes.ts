/** Health check routes — GET /healthz, GET /readyz */

import { Type } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";

const HealthResponse = Type.Object({ status: Type.String() });
const ReadyResponse = Type.Object({ status: Type.String(), db: Type.String() });

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness probe — always returns 200 if process is running */
  app.get("/healthz", { schema: { response: { 200: HealthResponse } } }, async () => {
    return { status: "ok" };
  });

  /** Readiness probe — checks database connectivity */
  app.get(
    "/readyz",
    { schema: { response: { 200: ReadyResponse, 503: ReadyResponse } } },
    async (_request, reply) => {
      try {
        await db.execute(sql`SELECT 1`);
        return { status: "ready", db: "ok" };
      } catch {
        return reply.status(503).send({ status: "not ready", db: "error" });
      }
    },
  );
}
