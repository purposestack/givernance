/**
 * W3C trace-context propagation helpers.
 *
 * Issue #56 Platform #4 / PR #54 review: the outbox relay currently loses the
 * API request's trace context when it enqueues jobs into BullMQ, so the
 * worker can't correlate its logs with the originating request. We write a
 * `traceparent` into `outbox_events.metadata` at insert time; the relay reads
 * it back and attaches it to the BullMQ job data; the worker seeds
 * `jobLogger({ traceId })` from it so Loki queries stitch together across
 * service boundaries.
 *
 * We do NOT pull in a full OTel SDK for this. The W3C trace-context header
 * is a plain string (`version-traceId-parentId-flags`), and we just need to
 * shuttle it around. If an upstream OTel-instrumented client sends us a
 * `traceparent` header, we preserve it unchanged; if nothing is present, we
 * synthesise one rooted at the Fastify request id so every persisted event is
 * still correlatable back to the originating request.
 */

import { randomBytes } from "node:crypto";
import type { OutboxMetadata } from "@givernance/shared/schema";
import type { FastifyRequest } from "fastify";

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";
// Matches W3C trace-context §2.1: `00-<32-hex>-<16-hex>-<2-hex>`.
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

// Re-export so in-package callers can keep importing `OutboxMetadata` from
// the trace-context helper if they prefer.
export type { OutboxMetadata };

/**
 * Build the `metadata` payload for an outbox insert. Prefers an incoming
 * upstream traceparent; falls back to a synthetic one derived from the
 * request id so every write is traceable even without an OTel collector.
 */
export function buildOutboxMetadata(
  request: FastifyRequest,
): Required<Pick<OutboxMetadata, "traceparent">> & OutboxMetadata {
  const incoming = request.headers[TRACEPARENT_HEADER];
  if (typeof incoming === "string" && TRACEPARENT_RE.test(incoming)) {
    const tracestate = request.headers[TRACESTATE_HEADER];
    return {
      traceparent: incoming,
      ...(typeof tracestate === "string" ? { tracestate } : {}),
    };
  }
  return { traceparent: synthesiseTraceparent(request.id) };
}

/**
 * Synthesize a W3C traceparent. The trace-id is deterministic from the
 * Fastify request id (hashed, padded) so logs and audits can still be joined
 * without losing the request↔trace link; the span-id is random per insert so
 * concurrent events don't share spans.
 */
function synthesiseTraceparent(requestId: string | undefined): string {
  const traceId = requestIdToTraceId(requestId);
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

function requestIdToTraceId(requestId: string | undefined): string {
  const base = requestId ?? randomBytes(16).toString("hex");
  // 32 hex chars. Trim or right-pad with a hash of itself so every input
  // produces a stable, 128-bit-looking trace-id.
  const hex = base.replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (hex.length >= 32) return hex.slice(0, 32);
  return hex.padEnd(32, "0");
}

/** Extract the 32-hex trace-id component from a traceparent string. */
export function extractTraceId(traceparent: string | undefined | null): string | undefined {
  if (!traceparent || !TRACEPARENT_RE.test(traceparent)) return undefined;
  return traceparent.split("-")[1];
}
