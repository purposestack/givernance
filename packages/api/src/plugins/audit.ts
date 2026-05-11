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

/**
 * Insert the audit row + handle the GDPR-flagged failure branch. Lives
 * outside the hook body so the hook's cognitive complexity stays under
 * Biome's ceiling. (PR #352 review — fix for the complexity bump
 * introduced by `resolveAuditOrgId`.)
 */
async function persistAuditRow(
  request: FastifyRequest,
  auditOrgId: string,
  routeUrl: string,
  ipHash: string,
): Promise<void> {
  try {
    await withTenantContext(auditOrgId, async (tx) => {
      await tx.insert(auditLogs).values({
        orgId: auditOrgId,
        userId: request.auth?.userId ?? "",
        // RFC 8693 `act` claim: when an admin impersonates a user (issue
        // #24, ADR-016) the JWT carries `{ sub: <user>, act: { sub: <admin> } }`.
        // We record the actor ONLY when it differs from the subject, i.e.
        // only for impersonated requests. Under normal auth `actor_id` is
        // NULL, which is honest — there is no separate actor. Audit readers
        // who want the effective actor compute `COALESCE(actor_id, user_id)`.
        // (PR #142 review M2.)
        actorId: request.auth?.act?.sub ?? null,
        // Issue #24 — when the request was authenticated through an
        // impersonation token, persist the session id and mode so SIEM
        // filters can isolate the full session trail without having to
        // reconstruct it heuristically from `actor_id`.
        impersonationSessionId: request.auth?.impersonation?.sessionId ?? null,
        impersonationMode: request.auth?.impersonation?.mode ?? null,
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
    // so alerting can catch audit failures. Carry forward the auth/rbac
    // discriminators so SOC can correlate a failed audit insert with the
    // original denial reason without joining on `reqId` (review L8).
    request.log.error(
      {
        err,
        method: request.method,
        url: request.url,
        audit: "INSERT_FAILED",
        ...(request.authDenial ? { authDenial: request.authDenial } : {}),
        ...(request.rbacDenial ? { rbacDenial: request.rbacDenial } : {}),
      },
      "CRITICAL: audit log insert failed — GDPR accountability gap",
    );
  }
}

/**
 * Emit the structured `audit` info-level log line alongside the DB
 * row. Issue #182 + PR #185 review pinned the discriminator shape;
 * extracted here so the hook body stays linear.
 */
function emitAuditInfoLine(request: FastifyRequest, reply: FastifyReply): void {
  request.log.info(
    {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      userId: request.auth?.userId,
      actorId: request.auth?.act?.sub ?? null,
      orgId: request.auth?.orgId,
      // Issue #24 — log the impersonation discriminators alongside auth
      // metadata so LogQL `audit{impersonationMode="..."}` lights up the
      // full session trail without joining audit_logs.
      ...(request.auth?.impersonation
        ? {
            impersonationMode: request.auth.impersonation.mode,
            impersonationSessionId: request.auth.impersonation.sessionId,
          }
        : {}),
      // Issue #182 + PR #185 review PJD-5 / L2: split discriminators.
      // `authDenial` for the 401 branch (missing/invalid token) so SOC
      // dashboards filtering for RBAC probing can EXCLUDE these as
      // benign auth noise; `rbacDenial` for the 403/404 role-rejection
      // branch with structured `requiredRoles` array.
      ...(request.authDenial ? { authDenial: request.authDenial } : {}),
      ...(request.rbacDenial ? { rbacDenial: request.rbacDenial } : {}),
    },
    "audit",
  );
}

async function audit(app: FastifyInstance) {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    // Only audit mutating methods
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    // Only audit authenticated requests with a tenant scope.
    //
    // `org_id` is a required Keycloak JWT claim (`verifyKeycloakJwt`
    // rejects tokens without it), so this branch fires for the few
    // remaining auth modes that don't carry one (e.g. system-issued
    // service tokens). Super-admin actions still land in audit_logs
    // under whatever `org_id` their token carries — for delegation
    // mode that's the target tenant, for platform-scoped actions
    // (`/v1/admin/*`) that's the Keycloak platform org. Routing
    // platform-scoped audits to the `__platform__` sentinel tenant
    // for cleaner SIEM filtering is tracked separately (PR #352
    // review Log-H1 noted this; cross-cutting follow-up).
    if (!request.auth?.orgId) return;

    const routeUrl = request.routeOptions.url ?? request.url;
    const ipHash = createHash("sha256").update(request.ip).digest("hex").slice(0, 16);

    await persistAuditRow(request, request.auth.orgId, routeUrl, ipHash);
    emitAuditInfoLine(request, reply);
  });
}

export const auditPlugin = fp(audit, {
  name: "audit",
  dependencies: ["auth"],
});
