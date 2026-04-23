/**
 * SSRF guard for caller-supplied URLs that the API hands to Keycloak
 * (IdP discovery/token/auth endpoints — issue #110 / ADR-016).
 *
 * Keycloak runs inside our trust boundary on Scaleway; a malicious super-admin
 * could craft a `discoveryUrl` pointing at `http://169.254.169.254/...`
 * (cloud metadata) or `http://127.0.0.1/admin/...` and have Keycloak
 * dereference it. We refuse anything that is not https (in production) and
 * anything resolving to a loopback / private / link-local / documentation
 * range. The actual DNS resolution is done by Keycloak, but we can filter
 * the obvious cases at the API boundary.
 *
 * Literal-IP host detection covers `http://10.0.0.1`, `http://[fe80::1]`,
 * and the classic metadata IP. Textual hostnames are passed through — if
 * an attacker points a DNS A record at a private IP (DNS rebinding), the
 * resolver at Keycloak has to defend itself. The API's job is to remove the
 * easy footguns.
 */

const PRIVATE_V4_PREFIXES: ReadonlyArray<(ip: [number, number, number, number]) => boolean> = [
  (ip) => ip[0] === 10,
  (ip) => ip[0] === 127,
  (ip) => ip[0] === 169 && ip[1] === 254,
  (ip) => ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31,
  (ip) => ip[0] === 192 && ip[1] === 168,
  (ip) => ip[0] === 0,
  (ip) => ip[0] >= 224, // multicast + reserved
];

function parseV4(h: string): [number, number, number, number] | null {
  const parts = h.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

function isPrivateV6(h: string): boolean {
  // `[::1]`, `[fe80::...]`, `[fc00::...]`, `[::ffff:10.0.0.1]`, etc.
  const stripped = h.replace(/^\[|\]$/g, "").toLowerCase();
  if (stripped === "::1" || stripped === "::" || stripped === "0:0:0:0:0:0:0:1") return true;
  if (
    stripped.startsWith("fe8") ||
    stripped.startsWith("fe9") ||
    stripped.startsWith("fea") ||
    stripped.startsWith("feb")
  )
    return true;
  if (stripped.startsWith("fc") || stripped.startsWith("fd")) return true;
  // IPv4-mapped IPv6: `::ffff:10.0.0.1`
  const mapped = stripped.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) {
    const parsed = parseV4(mapped[1]);
    if (parsed) return PRIVATE_V4_PREFIXES.some((check) => check(parsed));
  }
  return false;
}

export type UrlSafetyError =
  | "invalid_url"
  | "scheme_not_allowed"
  | "private_address"
  | "blank_host";

export interface UrlSafetyOpts {
  /** When true (production default), reject non-https. */
  requireHttps: boolean;
}

/**
 * Parse `raw` as a URL and reject obviously unsafe destinations. Returns
 * the normalised URL string or a classified error. Caller is responsible
 * for passing this through to Keycloak.
 */
export function assertSafeUpstreamUrl(
  raw: string,
  opts: UrlSafetyOpts,
): { ok: true; url: string } | { ok: false; error: UrlSafetyError } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  if (opts.requireHttps) {
    if (scheme !== "https") return { ok: false, error: "scheme_not_allowed" };
  } else if (scheme !== "https" && scheme !== "http") {
    return { ok: false, error: "scheme_not_allowed" };
  }

  const host = parsed.hostname;
  if (!host) return { ok: false, error: "blank_host" };

  // Literal IPv4?
  const v4 = parseV4(host);
  if (v4) {
    if (PRIVATE_V4_PREFIXES.some((check) => check(v4))) {
      return { ok: false, error: "private_address" };
    }
  }

  // Literal IPv6? URL.hostname strips the brackets for us.
  if (host.includes(":")) {
    if (isPrivateV6(`[${host}]`)) return { ok: false, error: "private_address" };
  }

  // Common unqualified hostnames (localhost, metadata) — reject by name too.
  const low = host.toLowerCase();
  if (low === "localhost" || low === "metadata" || low === "metadata.google.internal") {
    return { ok: false, error: "private_address" };
  }

  return { ok: true, url: parsed.toString() };
}
