/**
 * Unit tests — shared W3C trace-context helpers (issue #55).
 * Pure string manipulation; no DB, no Fastify, no BullMQ.
 */

import { describe, expect, it } from "vitest";
import {
  extractTraceId,
  isValidTraceparent,
  synthesiseTraceparent,
  TRACEPARENT_RE,
} from "../lib/trace-context.js";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("extractTraceId", () => {
  it("returns the 32-hex trace-id from a valid traceparent", () => {
    expect(extractTraceId(VALID)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("returns undefined for null and undefined", () => {
    expect(extractTraceId(null)).toBeUndefined();
    expect(extractTraceId(undefined)).toBeUndefined();
  });

  it("returns undefined for malformed inputs", () => {
    expect(extractTraceId("")).toBeUndefined();
    expect(extractTraceId("not-a-traceparent")).toBeUndefined();
    // Wrong version prefix.
    expect(extractTraceId(VALID.replace(/^00/, "01"))).toBeUndefined();
    // Uppercase hex is invalid per W3C §2.1 (lowercase only).
    expect(extractTraceId(VALID.toUpperCase())).toBeUndefined();
    // Truncated trace-id.
    expect(extractTraceId("00-4bf92f3577b34da6-00f067aa0ba902b7-01")).toBeUndefined();
  });
});

describe("synthesiseTraceparent", () => {
  it("produces a valid traceparent", () => {
    const tp = synthesiseTraceparent("req-1");
    expect(TRACEPARENT_RE.test(tp)).toBe(true);
    expect(isValidTraceparent(tp)).toBe(true);
  });

  it("derives a deterministic 32-hex trace-id from the request id", () => {
    const a = extractTraceId(synthesiseTraceparent("abc123def456"));
    const b = extractTraceId(synthesiseTraceparent("abc123def456"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    // Non-hex chars are stripped, remainder right-padded with zeros.
    expect(a).toBe("abc123def456".padEnd(32, "0"));
  });

  it("truncates over-long hex inputs to 32 chars", () => {
    const long = "f".repeat(64);
    expect(extractTraceId(synthesiseTraceparent(long))).toBe("f".repeat(32));
  });

  it("still produces a valid traceparent when the request id is undefined", () => {
    expect(isValidTraceparent(synthesiseTraceparent(undefined))).toBe(true);
  });

  it("uses a distinct span-id per call so concurrent events don't share spans", () => {
    const spanOf = (tp: string) => tp.split("-")[2];
    const first = synthesiseTraceparent("same-request");
    const second = synthesiseTraceparent("same-request");
    expect(spanOf(first)).not.toBe(spanOf(second));
  });
});

describe("isValidTraceparent", () => {
  it("accepts a well-formed version-00 traceparent", () => {
    expect(isValidTraceparent(VALID)).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidTraceparent("")).toBe(false);
    expect(isValidTraceparent("00-short-short-01")).toBe(false);
    expect(isValidTraceparent(`${VALID}-extra`)).toBe(false);
  });
});
