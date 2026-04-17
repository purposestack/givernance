import { NextResponse } from "next/server";
import { APP_URL, AUTH_ENDPOINT, KEYCLOAK_CLIENT_ID } from "@/lib/auth/keycloak";

/**
 * GET /api/auth/login
 *
 * Redirects the browser to the Keycloak authorization endpoint to begin
 * the OIDC Authorization Code flow. The user authenticates on Keycloak,
 * then Keycloak redirects back to /api/auth/callback with a code.
 */
export function GET() {
  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/auth/callback`,
    response_type: "code",
    scope: "openid profile email",
  });

  return NextResponse.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
}
