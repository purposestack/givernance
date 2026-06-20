export const JWT_COOKIE_NAME = "givernance_jwt";
export const ID_TOKEN_COOKIE_NAME = "givernance_id_token";
export const REFRESH_TOKEN_COOKIE_NAME = "givernance_refresh_token";

/** Default session TTL when Keycloak omits explicit expiry metadata. */
export const COOKIE_MAX_AGE_S = 8 * 60 * 60;

export function resolveSessionMaxAge(tokens: {
  refresh_expires_in?: number;
  expires_in?: number;
}): number {
  const refreshTtl = normalizePositiveInt(tokens.refresh_expires_in);
  if (refreshTtl) return refreshTtl;

  const accessTtl = normalizePositiveInt(tokens.expires_in);
  if (accessTtl) return accessTtl;

  return COOKIE_MAX_AGE_S;
}

export function jwtCookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: maxAge ?? COOKIE_MAX_AGE_S,
  };
}

/**
 * Cookie options for the two session tokens that the Fastify API never
 * reads: the `id_token` (used only as `id_token_hint` at logout) and the
 * `refresh_token` (used only by `/api/auth/refresh` + the
 * `/api/auth/restore-session` silent-refresh route).
 *
 * Issue #296: scoping these to `Path=/api/auth` means the browser never
 * attaches them to `/api/v1/*` (the API rewrite) or to page navigations.
 * That keeps ~2.3 KB of token payload — including the ID token's PII
 * claims (`email`, `name`, …) — off every request that reaches the API,
 * which was tipping authenticated calls over Node's 16 KB
 * `--max-http-header-size` (431 `HPE_HEADER_OVERFLOW`). Unlike stripping
 * headers in the proxy, path-scoping is mechanism-independent: the
 * browser simply does not send a cookie whose `Path` doesn't match.
 *
 * Same security flags as `jwtCookieOptions` (httpOnly, Secure in prod,
 * SameSite=Strict) — only the `path` narrows.
 */
export function authScopedCookieOptions(maxAge?: number) {
  return {
    ...jwtCookieOptions(maxAge),
    path: "/api/auth",
  };
}

export function decodeJwtExp(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  const payloadPart = parts[1];
  if (!payloadPart) return undefined;

  try {
    const base64 = toBase64(payloadPart);
    const payload = JSON.parse(atob(base64)) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an access token is already past its `exp`. Deliberately a
 * *hard*-expiry check, not a near-expiry/grace one: on a ~5-min-lifespan
 * access token a grace-window check would be true on nearly every request
 * and so must not gate a redirect. The proxy uses this to decide when a
 * full-page navigation must detour through `/api/auth/restore-session`:
 * a token that is merely near-expiry is still usable and the client-side
 * silent-refresh timer keeps it fresh — only an *expired* (or absent)
 * token forces the server-side restore (issue #296). A token with no
 * decodable `exp` is treated as not-expired; the API is the authority.
 */
export function isJwtExpired(
  token: string | undefined,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  if (!token) return true;
  const exp = decodeJwtExp(token);
  if (!exp) return false;
  return exp <= nowS;
}

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return undefined;
  }

  return value;
}

function toBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (padding === 0) return normalized;
  return `${normalized}${"=".repeat(4 - padding)}`;
}
