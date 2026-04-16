import { NextResponse } from "next/server";

const KEYCLOAK_URL = process.env["KEYCLOAK_URL"] ?? "http://localhost:8080";
const KEYCLOAK_REALM = process.env["KEYCLOAK_REALM"] ?? "givernance";
const KEYCLOAK_CLIENT_ID = process.env["KEYCLOAK_CLIENT_ID"] ?? "givernance-web";
const APP_URL = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";

const AUTH_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`;

/**
 * GET /api/auth/login
 *
 * Redirects the browser to the Keycloak authorization endpoint to begin the OIDC flow.
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
