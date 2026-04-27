import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { getCsrfCookieName } from "@/lib/auth/csrf";
import {
  APP_URL,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  KEYCLOAK_CLIENT_ID,
  LOGOUT_ENDPOINT,
  REFRESH_TOKEN_COOKIE_NAME,
} from "@/lib/auth/keycloak";

/**
 * Allowlist of safe `return_to` paths. Prevents open-redirect by restricting
 * the post-logout destination to known in-app routes that benefit from a
 * round-trip (e.g. the `/invite/accept` flow per PR #154 follow-up — the
 * invitee may have arrived while another user was signed in).
 */
const RETURN_TO_PATH_ALLOWLIST = new Set<string>(["/invite/accept"]);

/**
 * POST /api/auth/logout
 *
 * Clears the JWT + id_token cookies and redirects to Keycloak's end-session
 * endpoint to invalidate the Keycloak session, then to a destination URL.
 * Defaults to `/login` if no `return_to` form field is supplied.
 *
 * Passing `id_token_hint` makes Keycloak log the user out silently — without
 * it the user sees a "Do you want to log out?" confirmation page.
 *
 * POST-only to prevent CSRF session disruption via GET (e.g. <img src="/api/auth/logout">).
 * Redirect is 303 so the browser follows with GET, which Keycloak accepts.
 */
export async function POST(request: NextRequest) {
  const jar = await cookies();
  const idToken = jar.get(ID_TOKEN_COOKIE_NAME)?.value;
  jar.delete(JWT_COOKIE_NAME);
  jar.delete(ID_TOKEN_COOKIE_NAME);
  jar.delete(REFRESH_TOKEN_COOKIE_NAME);
  jar.delete(getCsrfCookieName());

  const postLogoutRedirectUri = await resolvePostLogoutRedirectUri(request);

  const params = new URLSearchParams({
    post_logout_redirect_uri: postLogoutRedirectUri,
    client_id: KEYCLOAK_CLIENT_ID,
  });
  if (idToken) {
    params.set("id_token_hint", idToken);
  }

  return NextResponse.redirect(`${LOGOUT_ENDPOINT}?${params.toString()}`, 303);
}

async function resolvePostLogoutRedirectUri(request: NextRequest): Promise<string> {
  const fallback = `${APP_URL}/login`;
  let returnTo: string | null = null;
  try {
    const form = await request.formData();
    const raw = form.get("return_to");
    returnTo = typeof raw === "string" ? raw : null;
  } catch {
    // No form body or unparseable — fall through to default.
  }
  if (!returnTo) return fallback;

  // Reject anything that isn't a same-origin absolute path. Defends against
  // protocol-relative (`//evil.com`), backslash (`\\evil.com`), and
  // absolute-URL injections (`https://evil.com`).
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.startsWith("/\\")) {
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(returnTo, APP_URL);
  } catch {
    return fallback;
  }
  if (!RETURN_TO_PATH_ALLOWLIST.has(parsed.pathname)) {
    return fallback;
  }
  // Round-trip through `URL` discards anything before the path (host, scheme,
  // userinfo) and re-serialises the search/hash, leaving only the safe
  // path + query the caller passed.
  return `${APP_URL}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
