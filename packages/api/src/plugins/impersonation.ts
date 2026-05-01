/**
 * Impersonation plugin (issue #24).
 *
 * Runs after the auth plugin. For requests authenticated through an
 * impersonation token, it:
 *
 *   1. **Mode `impersonation` (pure)** — blocks all mutating methods
 *      (POST/PUT/PATCH/DELETE) on data routes. The operator is here to
 *      reproduce a bug, not to mutate. The only mutating exceptions are
 *      session-management endpoints (`DELETE /v1/admin/impersonation/...`)
 *      so the operator can always end their own session, and Keycloak
 *      callback routes that share the host.
 *
 *   2. **Mode `delegation`** — no write block (the operator's super_admin
 *      powers are retained on purpose; doc-19 §6 "delegation = droits
 *      étendus explicites"). The audit double-attribution is the entire
 *      accountability story for delegation mode.
 *
 * The plugin does NOT alter `request.auth` — that's already populated by
 * the auth plugin. It only enforces guard semantics.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { problemDetail } from "../lib/schemas.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes that remain mutating-callable while in pure impersonation mode.
 *
 *   - `DELETE /v1/admin/impersonation/...`  ← always lets the operator
 *     end the session, even from inside it.
 *
 * Add new entries here ONLY when there is a clear product reason a pure-
 * impersonation session needs to perform that mutation; default-deny is
 * the security stance.
 */
const PURE_IMPERSONATION_WRITE_ALLOWLIST: Array<{ method: string; pattern: RegExp }> = [
  // Tightened to a UUID slot — review M3 — so it cannot accidentally match
  // `/v1/admin/impersonation/user/...` or any future sibling route.
  {
    method: "DELETE",
    pattern:
      /^\/v1\/admin\/impersonation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
];

async function impersonation(app: FastifyInstance) {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth?.impersonation) return;
    if (auth.impersonation.mode !== "impersonation") return;
    if (SAFE_METHODS.has(request.method)) return;

    if (isAllowlistedWrite(request.method, request.url)) return;

    request.log.warn(
      {
        method: request.method,
        url: request.url,
        sessionId: auth.impersonation.sessionId,
        actorId: auth.act?.sub ?? null,
        userId: auth.userId,
        audit: "impersonation.write_blocked",
      },
      "impersonation: write blocked in pure-impersonation mode",
    );

    return reply
      .status(403)
      .send(
        problemDetail(
          403,
          "Forbidden",
          "Pure impersonation sessions are read-only. To make changes, restart the session in 'delegation' mode.",
        ),
      );
  });
}

function isAllowlistedWrite(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return PURE_IMPERSONATION_WRITE_ALLOWLIST.some(
    (rule) => rule.method === method && rule.pattern.test(path),
  );
}

export const impersonationPlugin = fp(impersonation, {
  name: "impersonation",
  dependencies: ["auth"],
});
