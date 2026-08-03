/**
 * W3C trace-context propagation helpers — Fastify-facing side.
 *
 * Issue #56 Platform #4 / PR #54 review: the outbox relay currently loses the
 * API request's trace context when it enqueues jobs into BullMQ, so the
 * worker can't correlate its logs with the originating request. We write a
 * `traceparent` into `outbox_events.metadata` at insert time; the relay reads
 * it back and attaches it to the BullMQ job data; the worker seeds
 * `jobLogger({ traceId })` from it so Loki queries stitch together across
 * service boundaries.
 *
 * The pure helpers (regex, `extractTraceId`, `synthesiseTraceparent`) now
 * live in `@givernance/shared/lib/trace-context` (issue #55) so the worker
 * copy can't drift. Only `buildOutboxMetadata` stays here — it depends on
 * `FastifyRequest`.
 */

import {
  extractTraceId,
  isValidTraceparent,
  synthesiseTraceparent,
} from "@givernance/shared/lib/trace-context";
import type { OutboxMetadata } from "@givernance/shared/schema";
import type { FastifyRequest } from "fastify";

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";

// Re-export so in-package callers can keep importing `OutboxMetadata` and
// `extractTraceId` from the trace-context helper if they prefer.
export type { OutboxMetadata };
export { extractTraceId };

/**
 * Build the `metadata` payload for an outbox insert. Prefers an incoming
 * upstream traceparent; falls back to a synthetic one derived from the
 * request id so every write is traceable even without an OTel collector.
 *
 * Also forwards the impersonation context (issue #24) from
 * `request.auth.impersonation` so worker-side audit writes can carry the
 * same double-attribution / mode discriminator that the API audit plugin
 * does. Pure-impersonation requests can't reach this code path (the
 * impersonation plugin blocks writes), but delegation requests legitimately
 * mutate state — those land here.
 */
export function buildOutboxMetadata(
  request: FastifyRequest,
): Required<Pick<OutboxMetadata, "traceparent">> & OutboxMetadata {
  const impersonationFields = buildImpersonationMetadata(request);
  const incoming = request.headers[TRACEPARENT_HEADER];
  if (typeof incoming === "string" && isValidTraceparent(incoming)) {
    const tracestate = request.headers[TRACESTATE_HEADER];
    return {
      traceparent: incoming,
      ...(typeof tracestate === "string" ? { tracestate } : {}),
      ...impersonationFields,
    };
  }
  return {
    traceparent: synthesiseTraceparent(request.id),
    ...impersonationFields,
  };
}

function buildImpersonationMetadata(
  request: FastifyRequest,
): Pick<OutboxMetadata, "impersonationSessionId" | "impersonationMode" | "impersonatorKeycloakId"> {
  const imp = request.auth?.impersonation;
  const actorSub = request.auth?.act?.sub;
  if (!imp || !actorSub) return {};
  return {
    impersonationSessionId: imp.sessionId,
    impersonationMode: imp.mode,
    impersonatorKeycloakId: actorSub,
  };
}
