/**
 * Worker-side W3C trace-context helpers — mirrors
 * `packages/api/src/lib/trace-context.ts` (issue #56 Platform #4).
 *
 * Duplication is deliberate: the worker package must not import from the API
 * package (module layering, see monorepo setup). Keep the regex and trace-id
 * extraction behaviour identical between the two copies; a follow-up can
 * hoist to `@givernance/shared` once the outbox metadata shape stabilises.
 */

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Extract the 32-hex trace-id component from a traceparent string. */
export function extractTraceId(traceparent: string | undefined | null): string | undefined {
  if (!traceparent || !TRACEPARENT_RE.test(traceparent)) return undefined;
  return traceparent.split("-")[1];
}
