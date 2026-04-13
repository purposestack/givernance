/** Audit log middleware — persists all mutating requests to audit_logs */

import { auditLogs } from "@givernance/shared/schema";
import { createHash } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../lib/db.js";

/** Extract the top-level resource type from a /v1/<resource>/... URL */
function extractResourceType(url: string): string | undefined {
  const match = /\/v1\/([^/?]+)/.exec(url);
  return match?.[1];
}

async function audit(app: FastifyInstance) {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    // Only audit mutating methods
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    // Only audit authenticated requests
    if (!request.auth?.orgId) return;

    const routeUrl = request.routeOptions.url ?? request.url;
    const ipHash = createHash("sha256").update(request.ip).digest("hex").slice(0, 16);

    try {
      await db.insert(auditLogs).values({
        orgId: request.auth.orgId,
        userId: request.auth.userId,
        action: `${request.method}:${routeUrl}`,
        resourceType: extractResourceType(routeUrl),
        ipHash,
        userAgent: request.headers["user-agent"] ?? undefined,
      });
    } catch (err) {
      // Log but never fail the request due to an audit error
      request.log.error({ err, method: request.method, url: request.url }, "audit insert failed");
    }

    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        userId: request.auth.userId,
        orgId: request.auth.orgId,
      },
      "audit",
    );
  });
}

export const auditPlugin = fp(audit, {
  name: "audit",
  dependencies: ["auth"],
});
