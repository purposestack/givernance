/**
 * Unit tests — buildOutboxMetadata header handling (issue #55).
 * No DB; a plain object stands in for the FastifyRequest surface we read
 * (headers, id, auth).
 */

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { buildOutboxMetadata } from "./trace-context.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return { headers, id: "req-1", auth: undefined } as unknown as FastifyRequest;
}

describe("buildOutboxMetadata", () => {
  it("preserves a valid upstream traceparent", () => {
    const meta = buildOutboxMetadata(fakeRequest({ traceparent: VALID_TRACEPARENT }));
    expect(meta.traceparent).toBe(VALID_TRACEPARENT);
  });

  it("synthesises a traceparent when the header is missing or malformed", () => {
    for (const req of [fakeRequest(), fakeRequest({ traceparent: "garbage" })]) {
      const meta = buildOutboxMetadata(req);
      expect(meta.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      expect(meta.traceparent).not.toBe(VALID_TRACEPARENT);
    }
  });

  it("forwards a well-formed tracestate alongside a valid traceparent", () => {
    const meta = buildOutboxMetadata(
      fakeRequest({ traceparent: VALID_TRACEPARENT, tracestate: "vendor=opaque" }),
    );
    expect(meta.tracestate).toBe("vendor=opaque");
  });

  it("drops a tracestate over 512 chars (persisted client input — W3C §3.3.1.1 cap)", () => {
    const meta = buildOutboxMetadata(
      fakeRequest({ traceparent: VALID_TRACEPARENT, tracestate: "a".repeat(513) }),
    );
    expect(meta.tracestate).toBeUndefined();
  });

  it("drops a tracestate containing non-printable-ASCII bytes", () => {
    for (const tracestate of ["evil\nvalue", "évil=1", "bad\u0007byte"]) {
      const meta = buildOutboxMetadata(fakeRequest({ traceparent: VALID_TRACEPARENT, tracestate }));
      expect(meta.tracestate).toBeUndefined();
    }
  });
});
