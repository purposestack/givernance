export const JWT_COOKIE_NAME = "givernance_jwt";
export const ID_TOKEN_COOKIE_NAME = "givernance_id_token";
export const REFRESH_TOKEN_COOKIE_NAME = "givernance_refresh_token";

/** Default session TTL when Keycloak omits explicit expiry metadata. */
export const COOKIE_MAX_AGE_S = 8 * 60 * 60;

/** Refresh slightly before the access token expires to avoid race conditions. */
export const SESSION_REFRESH_GRACE_S = 5 * 60;

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

export function shouldRefreshToken(
  token: string | undefined,
  nowS = Math.floor(Date.now() / 1000),
  graceS = SESSION_REFRESH_GRACE_S,
): boolean {
  if (!token) return false;
  const exp = decodeJwtExp(token);
  if (!exp) return false;
  return exp - nowS <= graceS;
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
