const LOGIN_ROUTE = "/api/auth/login";
/** Generous cap — a return path is a pathname + query, never a payload. */
const MAX_REDIRECT_LENGTH = 2048;

/**
 * Build the `/api/auth/login` URL the login page navigates to, forwarding the
 * post-login return path (issue #613). `/api/auth/restore-session` sends an
 * expired session to `/login?redirect=<path>`; the login route expects that
 * path as `return_to` and persists it across the OIDC round-trip.
 *
 * The server is the authority — `safeReturnToPath` re-validates `return_to`
 * as a same-origin path and the callback re-validates the cookie. This is
 * only a client-side shape check so an obviously foreign value is never even
 * forwarded: it must start with a single `/` (no `//host`, no `/\host`
 * protocol-relative forms) and carry no control characters.
 */
export function buildLoginHref(redirect: string | null | undefined): string {
  if (!isSafeRedirectShape(redirect)) return LOGIN_ROUTE;
  return `${LOGIN_ROUTE}?return_to=${encodeURIComponent(redirect)}`;
}

function isSafeRedirectShape(value: string | null | undefined): value is string {
  if (!value || value.length > MAX_REDIRECT_LENGTH) return false;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
