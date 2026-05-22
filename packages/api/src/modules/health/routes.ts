/** Health check routes — GET /healthz, GET /readyz */

import { donations } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";

const HealthResponse = Type.Object({ status: Type.String() });

const FxSubsystem = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("stale"), Type.Literal("down")]),
  cacheAgeHours: Type.Union([Type.Number(), Type.Null()]),
  lastSuccess: Type.Union([Type.String(), Type.Null()]),
  pendingBackfillCount: Type.Number(),
});

const ReadyResponse = Type.Object({
  status: Type.String(),
  db: Type.String(),
  fx: FxSubsystem,
});

async function getFxSubsystem(): Promise<{
  status: "ok" | "stale" | "down";
  cacheAgeHours: number | null;
  lastSuccess: string | null;
  pendingBackfillCount: number;
}> {
  let fxStatus: "ok" | "stale" | "down" = "down";
  let cacheAgeHours: number | null = null;
  let lastSuccess: string | null = null;

  try {
    const raw = await redis.get("fx:rates:EUR");
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { rates: Record<string, number>; timestamp: string };
      const ageMs = Date.now() - new Date(parsed.timestamp).getTime();
      cacheAgeHours = ageMs / 3_600_000;
      lastSuccess = parsed.timestamp;
      fxStatus = cacheAgeHours < 25 ? "ok" : "stale";
    }
  } catch {
    // Redis unavailable or parse error — leave status as "down"
  }

  let pendingBackfillCount = 0;
  try {
    const result = await db
      .select({ count: sql<number>`COUNT(*)::integer` })
      .from(donations)
      .where(eq(donations.fxPending, true));
    pendingBackfillCount = result[0]?.count ?? 0;
  } catch {
    // DB error for this sub-query is non-fatal; main db check below is authoritative
  }

  return { status: fxStatus, cacheAgeHours, lastSuccess, pendingBackfillCount };
}

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness probe — always returns 200 if process is running */
  app.get(
    "/healthz",
    { schema: { tags: ["Health"], response: { 200: HealthResponse } } },
    async () => {
      return { status: "ok" };
    },
  );

  /** Readiness probe — checks database connectivity and reports fx subsystem status */
  app.get(
    "/readyz",
    { schema: { tags: ["Health"], response: { 200: ReadyResponse, 503: ReadyResponse } } },
    async (_request, reply) => {
      try {
        await db.execute(sql`SELECT 1`);
        const fx = await getFxSubsystem();
        return { status: "ready", db: "ok", fx };
      } catch {
        const fx = await getFxSubsystem();
        return reply.status(503).send({ status: "not ready", db: "error", fx });
      }
    },
  );
}
