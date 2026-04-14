/** Audit log middleware — persists all mutating requests to audit_logs */

import { createHash } from "node:crypto";
import { auditLogs } from "@givernance/shared/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { withTenantContext } from "../lib/db.js";

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
      await withTenantContext(request.auth.orgId, async (tx) => {
        await tx.insert(auditLogs).values({
          orgId: request.auth?.orgId,
          userId: request.auth?.userId,
          action: `${request.method}:${routeUrl}`,
          resourceType: extractResourceType(routeUrl),
          ipHash,
          userAgent: request.headers["user-agent"] ?? undefined,
        });
      });
    } catch (err) {
      // Log error prominently — GDPR Art. 5(2) requires accountability (M3 fix).
      // We still don't fail the request, but we emit a structured error at 'error' level
      // so alerting can catch audit failures.
      request.log.error(
        { err, method: request.method, url: request.url, audit: "INSERT_FAILED" },
        "CRITICAL: audit log insert failed — GDPR accountability gap",
      );
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
