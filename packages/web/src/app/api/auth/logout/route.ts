import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const KEYCLOAK_URL = process.env["KEYCLOAK_URL"] ?? "http://localhost:8080";
const KEYCLOAK_REALM = process.env["KEYCLOAK_REALM"] ?? "givernance";
const APP_URL = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";

const LOGOUT_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/logout`;

/**
 * GET /api/auth/logout
 *
 * Clears the JWT cookie and redirects to Keycloak's end-session endpoint.
 */
export async function GET() {
  const jar = await cookies();
  jar.delete("givernance_jwt");

  const params = new URLSearchParams({
    post_logout_redirect_uri: `${APP_URL}/login`,
    client_id: process.env["KEYCLOAK_CLIENT_ID"] ?? "givernance-web",
  });

  return NextResponse.redirect(`${LOGOUT_ENDPOINT}?${params.toString()}`);
}
