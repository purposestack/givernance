/**
 * DNS TXT verification for the enterprise domain-claim flow (issue #110 /
 * ADR-016). Small, injectable wrapper so integration tests can stub the
 * resolver without racing against real DNS caches.
 *
 * Security posture:
 *  - Always returns a discriminated-union result; never throws to the caller.
 *    The resolver surface must not leak internal errors (ENOTFOUND vs
 *    ETIMEDOUT vs SERVFAIL) into HTTP response bodies.
 *  - Timeout bounded at 5s per resolver call to avoid a slow DNS server
 *    holding a request-handling worker.
 *  - TXT value comparison is exact-string, whitespace-trimmed. We never
 *    interpret substring matches: a malicious neighbour publishing
 *    `givernance-verify=alice;givernance-verify=bob` must not claim both.
 */

import { Resolver } from "node:dns/promises";

export interface TxtVerifyInput {
  /** Fully-qualified domain to query (already lowercased + validated). */
  domain: string;
  /** Exact TXT record value to look for. */
  expectedValue: string;
  /** Optional timeout in milliseconds; default 5000. */
  timeoutMs?: number;
}

export type TxtVerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "mismatch" | "lookup_error" | "timeout" };

export interface TxtResolver {
  /** Resolve TXT records as an array of string-arrays (node:dns shape). */
  resolveTxt(domain: string): Promise<string[][]>;
}

/** Default resolver — uses Node's system resolver with a bounded timeout. */
export function createSystemTxtResolver(): TxtResolver {
  const r = new Resolver({ timeout: 5_000, tries: 2 });
  return {
    resolveTxt: (domain) => r.resolveTxt(domain),
  };
}

/**
 * Does the domain publish the expected TXT value?
 *
 * TXT records are returned as chunks (each record is an array of strings).
 * Some providers split a long token into multiple chunks; joining them with
 * the empty string gives us the full value. We compare the concatenated
 * chunks against `expectedValue` exactly (after trimming whitespace).
 */
export async function verifyTxtRecord(
  resolver: TxtResolver,
  input: TxtVerifyInput,
): Promise<TxtVerifyResult> {
  const { domain, expectedValue } = input;
  const timeoutMs = input.timeoutMs ?? 5_000;

  let records: string[][];
  try {
    records = await Promise.race<string[][]>([
      resolver.resolveTxt(domain),
      new Promise<string[][]>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "timeout") return { ok: false, reason: "timeout" };
    // Any resolver failure (NXDOMAIN, SERVFAIL, network error) collapses into
    // a single generic 422. We log the actual reason at the call site.
    if (/ENOTFOUND|NXDOMAIN|ENODATA/i.test(msg)) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "lookup_error" };
  }

  if (records.length === 0) return { ok: false, reason: "not_found" };

  const expected = expectedValue.trim();
  for (const chunks of records) {
    const joined = chunks.join("").trim();
    if (joined === expected) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}

/** Generate a 32-byte random DNS TXT token, base64url encoded (~43 chars). */
export function generateDnsTxtValue(bytes: Uint8Array): string {
  return `givernance-verify=${Buffer.from(bytes).toString("base64url")}`;
}
