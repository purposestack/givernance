/**
 * W3C trace-context helpers — single source of truth (issue #55).
 *
 * Hoists the API/worker duplication flagged in the worker's copy
 * (`packages/worker/src/lib/trace-context.ts`, issue #56 Platform #4):
 * both packages carried an identical `TRACEPARENT_RE` + `extractTraceId`
 * because the worker must not import from the API package. The pure
 * (non-Fastify) helpers now live here; `buildOutboxMetadata` stays in
 * `packages/api/src/lib/trace-context.ts` because it depends on
 * `FastifyRequest`.
 *
 * We do NOT pull in a full OTel SDK for this. The W3C trace-context header
 * is a plain string (`version-traceId-parentId-flags`) and we just need to
 * shuttle it around across the outbox → relay → BullMQ boundary.
 */

import { createHash, randomBytes } from "node:crypto";

// Matches W3C trace-context §2.1: `00-<32-hex>-<16-hex>-<2-hex>`.
export const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Whether `s` is a syntactically valid version-00 traceparent. */
export function isValidTraceparent(s: string): boolean {
  return TRACEPARENT_RE.test(s);
}

/** Extract the 32-hex trace-id component from a traceparent string. */
export function extractTraceId(traceparent: string | undefined | null): string | undefined {
  if (!traceparent || !TRACEPARENT_RE.test(traceparent)) return undefined;
  return traceparent.split("-")[1];
}

/**
 * Synthesize a W3C traceparent. The trace-id is deterministic from the
 * given request/correlation id (SHA-256, truncated to 128 bits) so logs and
 * audits can still be joined without losing the request↔trace link; the
 * span-id is random per call so concurrent events don't share spans.
 */
export function synthesiseTraceparent(requestId: string | undefined): string {
  const traceId = requestIdToTraceId(requestId);
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

function requestIdToTraceId(requestId: string | undefined): string {
  const base = requestId ?? randomBytes(16).toString("hex");
  // SHA-256, truncated to 128 bits. Hashing (rather than hex-filtering the
  // input) keeps the full entropy of low-hex-density ids — Fastify's default
  // `req-<base36>` counters and Stripe `pi_…` base62 ids would otherwise
  // collide after filtering, and an id with no hex chars at all would yield
  // the all-zero trace-id that W3C §2.3.2 declares invalid.
  return createHash("sha256").update(base).digest("hex").slice(0, 32);
}
