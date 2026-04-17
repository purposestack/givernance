import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  APP_URL,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_CLIENT_SECRET,
  TOKEN_ENDPOINT,
} from "@/lib/auth/keycloak";

/**
 * GET /api/auth/callback
 *
 * Keycloak redirects here after the user authenticates.
 * Exchanges the authorization code for tokens, then sets an httpOnly cookie
 * with the access token (JWT) and redirects to the dashboard.
 *
 * Security: httpOnly + Secure + SameSite=Strict per ADR-011.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  // Keycloak returned an error (user cancelled, IdP failure, etc.)
  if (error) {
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", errorDescription ?? error);
    return NextResponse.redirect(loginUrl.toString());
  }

  // No authorization code — something went wrong
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

    // Set httpOnly cookie with the JWT (ADR-011: httpOnly + Secure + SameSite=Strict)
    const jar = await cookies();
    jar.set(JWT_COOKIE_NAME, tokens.access_token, jwtCookieOptions(tokens.expires_in));

    return NextResponse.redirect(new URL("/dashboard", APP_URL).toString());
  } catch {
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", "callback_failed");
    return NextResponse.redirect(loginUrl.toString());
  }
}
