import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { APP_URL, JWT_COOKIE_NAME, KEYCLOAK_CLIENT_ID, LOGOUT_ENDPOINT } from "@/lib/auth/keycloak";

/**
 * GET /api/auth/logout
 *
 * Clears the JWT cookie and redirects to Keycloak's end-session endpoint
 * which invalidates the Keycloak session and redirects back to /login.
 */
export async function GET() {
  const jar = await cookies();
  jar.delete(JWT_COOKIE_NAME);

  const params = new URLSearchParams({
    post_logout_redirect_uri: `${APP_URL}/login`,
    client_id: KEYCLOAK_CLIENT_ID,
  });

  return NextResponse.redirect(`${LOGOUT_ENDPOINT}?${params.toString()}`);
}
