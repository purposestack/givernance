import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCsrfCookieName } from "@/lib/auth/csrf";
import {
  APP_URL,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  KEYCLOAK_CLIENT_ID,
  LOGOUT_ENDPOINT,
} from "@/lib/auth/keycloak";

/**
 * POST /api/auth/logout
 *
 * Clears the JWT + id_token cookies and redirects to Keycloak's end-session
 * endpoint to invalidate the Keycloak session, then back to /login.
 *
 * Passing `id_token_hint` makes Keycloak log the user out silently — without
 * it the user sees a "Do you want to log out?" confirmation page.
 *
 * POST-only to prevent CSRF session disruption via GET (e.g. <img src="/api/auth/logout">).
 * Redirect is 303 so the browser follows with GET, which Keycloak accepts.
 */
export async function POST() {
  const jar = await cookies();
  const idToken = jar.get(ID_TOKEN_COOKIE_NAME)?.value;
  jar.delete(JWT_COOKIE_NAME);
  jar.delete(ID_TOKEN_COOKIE_NAME);
  jar.delete(getCsrfCookieName());

  const params = new URLSearchParams({
    post_logout_redirect_uri: `${APP_URL}/login`,
    client_id: KEYCLOAK_CLIENT_ID,
  });
  if (idToken) {
    params.set("id_token_hint", idToken);
  }

  return NextResponse.redirect(`${LOGOUT_ENDPOINT}?${params.toString()}`, 303);
}
