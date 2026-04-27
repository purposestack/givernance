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

/**
 * Extract the primary resource ID from a concrete request URL. The audit
 * plugin logs `routeUrl` (which contains placeholders like `:id`) for action
 * but needs the *actual* id for resourceId — so we also parse `request.url`.
 *
 * Matches `/v1/<resource>/<uuid>[/...]`. Returns undefined when the URL does
 * not address a specific resource (e.g. `POST /v1/constituents`) or when the
 * second segment is a route verb rather than an identifier (`/v1/public/qr/<token>`,
 * `/v1/audit`, `/v1/signup/resend`). Only UUID-shaped segments are treated as
 * `resourceId` because the audit_logs response schema advertises the column
 * as UUID-or-null and because non-UUID segments tend to be nouns (route verbs)
 * that don't belong in the resource-pointer slot.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractResourceId(actualUrl: string): string | undefined {
  const [path] = actualUrl.split("?");
  const match = /\/v1\/[^/]+\/([^/?]+)/.exec(path ?? "");
  const id = match?.[1];
  if (!id) return undefined;
  return UUID_RE.test(id) ? id : undefined;
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
          orgId: request.auth?.orgId ?? "",
          userId: request.auth?.userId ?? "",
          // RFC 8693 `act` claim: when an admin impersonates a user (issue
          // #24, ADR-016) the JWT carries `{ sub: <user>, act: { sub: <admin> } }`.
          // We record the actor ONLY when it differs from the subject, i.e.
          // only for impersonated requests. Under normal auth `actor_id` is
          // NULL, which is honest — there is no separate actor. Audit readers
          // who want the effective actor compute `COALESCE(actor_id, user_id)`.
          // (PR #142 review M2.)
          actorId: request.auth?.act?.sub ?? null,
          action: `${request.method}:${routeUrl}`,
          resourceType: extractResourceType(routeUrl),
          resourceId: extractResourceId(request.url),
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
        actorId: request.auth.act?.sub ?? null,
        orgId: request.auth.orgId,
        // Issue #182: structured RBAC denial discriminator. Set by the guard
        // primitives in `lib/guards.ts` on the denial branch; absent for
        // successful requests and for non-RBAC denials (CSRF, validation,
        // tenant-scoping). SOC dashboards filter on `rbacDenial.guard` to
        // separate RBAC probing from the other 403 sources.
        ...(request.rbacDenial ? { rbacDenial: request.rbacDenial } : {}),
      },
      "audit",
    );
  });
}

export const auditPlugin = fp(audit, {
  name: "audit",
  dependencies: ["auth"],
});
