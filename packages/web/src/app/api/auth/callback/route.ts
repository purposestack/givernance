import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

const KEYCLOAK_URL = process.env["KEYCLOAK_URL"] ?? "http://localhost:8080";
const KEYCLOAK_REALM = process.env["KEYCLOAK_REALM"] ?? "givernance";
const KEYCLOAK_CLIENT_ID = process.env["KEYCLOAK_CLIENT_ID"] ?? "givernance-web";
const KEYCLOAK_CLIENT_SECRET = process.env["KEYCLOAK_CLIENT_SECRET"] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:3001";
const APP_URL = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";

const TOKEN_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

/** Max age for the JWT cookie — 8 hours (matches typical Keycloak session) */
const COOKIE_MAX_AGE_S = 8 * 60 * 60;

/**
 * GET /api/auth/callback
 *
 * Keycloak redirects here after the user authenticates.
 * Exchanges the authorization code for tokens, then sets an httpOnly cookie
 * with the access token (JWT) and redirects to the dashboard.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (error) {
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", errorDescription ?? error);
    return NextResponse.redirect(loginUrl.toString());
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login", APP_URL).toString());
  }

  try {
    // Exchange the authorization code for tokens at the Keycloak token endpoint
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: KEYCLOAK_CLIENT_ID,
        client_secret: KEYCLOAK_CLIENT_SECRET,
        code,
        redirect_uri: `${APP_URL}/api/auth/callback`,
      }),
    });

    if (!tokenRes.ok) {
      const loginUrl = new URL("/login", APP_URL);
      loginUrl.searchParams.set("error", "token_exchange_failed");
      return NextResponse.redirect(loginUrl.toString());
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Optionally forward the token to the backend for session setup
    // This keeps the backend aware of active sessions
    await fetch(`${API_URL}/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ access_token: tokens.access_token }),
    }).catch(() => {
      // Non-blocking — backend session setup is best-effort in Phase 1
    });

    // Set httpOnly cookie with the JWT
    const jar = await cookies();
    jar.set("givernance_jwt", tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: tokens.expires_in ?? COOKIE_MAX_AGE_S,
    });

    return NextResponse.redirect(new URL("/dashboard", APP_URL).toString());
  } catch {
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", "callback_failed");
    return NextResponse.redirect(loginUrl.toString());
  }
}
