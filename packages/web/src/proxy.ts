import { type NextRequest, NextResponse } from "next/server";
import {
  decodeJwtExp,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
  resolveSessionMaxAge,
  shouldRefreshToken,
} from "@/lib/auth/session";

const CSRF_COOKIE_NAME = "csrf-token";
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "givernance";
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? "givernance-web";
const KEYCLOAK_CLIENT_SECRET =
  process.env.KEYCLOAK_CLIENT_SECRET ||
  process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_SECRET ||
  "ci-test-secret-do-not-use-in-production";
const TOKEN_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

/**
 * Route prefixes that require authentication.
 * Only includes implemented features — add new entries as pages are built.
 */
const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/select-organization", "/admin"];

/** Route prefixes that are always public (auth pages, API callbacks, static assets). */
const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/p",
  "/api/auth",
  "/_next",
  "/favicon.ico",
];

/**
 * FE-7 (PR #118 review): strict prefix match — `/admin` must NOT match
 * `/admin-something`. Either the entire path equals the prefix or the next
 * character is a slash.
 */
function prefixMatches(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => prefixMatches(p, pathname));
}

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => prefixMatches(p, pathname));
}

function mintCsrfToken(): string {
  return crypto.randomUUID();
}

function buildRequestHeaders(request: NextRequest, jwt?: string) {
  const requestHeaders = new Headers(request.headers);

  if (jwt) {
    requestHeaders.set("Authorization", `Bearer ${jwt}`);
  }

  return requestHeaders;
}

function ensureCsrfCookie(
  request: NextRequest,
  response: NextResponse,
  jwt?: string,
  maxAge?: number,
) {
  if (!jwt || request.cookies.get(CSRF_COOKIE_NAME)?.value) {
    return;
  }

  response.cookies.set(CSRF_COOKIE_NAME, mintCsrfToken(), {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: maxAge ?? jwtCookieOptions().maxAge,
  });
}

function upsertCookieHeader(
  request: NextRequest,
  updates: Record<string, string | undefined>,
): string | undefined {
  const cookies = new Map(request.cookies.getAll().map((cookie) => [cookie.name, cookie.value]));
  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }

  if (cookies.size === 0) return undefined;
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

function buildRequestHeadersWithCookies(
  request: NextRequest,
  jwt: string | undefined,
  cookieHeader: string | undefined,
) {
  const headers = buildRequestHeaders(request, jwt);
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  return headers;
}

interface RefreshedSession {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  sessionMaxAge: number;
}

async function refreshSession(refreshToken: string): Promise<RefreshedSession | null> {
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: KEYCLOAK_CLIENT_ID,
        client_secret: KEYCLOAK_CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const tokens = (await response.json()) as {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_expires_in?: number;
    };

    if (!tokens.access_token) {
      return null;
    }

    return {
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      sessionMaxAge: resolveSessionMaxAge(tokens),
    };
  } catch {
    return null;
  }
}

function clearSessionCookies(response: NextResponse) {
  response.cookies.delete(JWT_COOKIE_NAME);
  response.cookies.delete(ID_TOKEN_COOKIE_NAME);
  response.cookies.delete(REFRESH_TOKEN_COOKIE_NAME);
  response.cookies.delete(CSRF_COOKIE_NAME);
}

function applyRefreshedSession(
  response: NextResponse,
  request: NextRequest,
  session: RefreshedSession,
) {
  response.cookies.set(
    JWT_COOKIE_NAME,
    session.accessToken,
    jwtCookieOptions(session.sessionMaxAge),
  );
  if (session.idToken) {
    response.cookies.set(
      ID_TOKEN_COOKIE_NAME,
      session.idToken,
      jwtCookieOptions(session.sessionMaxAge),
    );
  }
  if (session.refreshToken) {
    response.cookies.set(
      REFRESH_TOKEN_COOKIE_NAME,
      session.refreshToken,
      jwtCookieOptions(session.sessionMaxAge),
    );
  }

  const csrfToken = request.cookies.get(CSRF_COOKIE_NAME)?.value ?? mintCsrfToken();
  response.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: session.sessionMaxAge,
  });
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let jwt = request.cookies.get(JWT_COOKIE_NAME)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)?.value;
  let refreshedSession: RefreshedSession | null = null;
  let cookieHeader = request.headers.get("cookie") ?? undefined;

  if (refreshToken && shouldRefreshToken(jwt)) {
    refreshedSession = await refreshSession(refreshToken);
    if (refreshedSession) {
      jwt = refreshedSession.accessToken;
      cookieHeader = upsertCookieHeader(request, {
        [JWT_COOKIE_NAME]: refreshedSession.accessToken,
        ...(refreshedSession.idToken ? { [ID_TOKEN_COOKIE_NAME]: refreshedSession.idToken } : {}),
        ...(refreshedSession.refreshToken
          ? { [REFRESH_TOKEN_COOKIE_NAME]: refreshedSession.refreshToken }
          : {}),
      });
    } else if ((decodeJwtExp(jwt ?? "") ?? 0) <= Math.floor(Date.now() / 1000)) {
      jwt = undefined;
      cookieHeader = upsertCookieHeader(request, {
        [JWT_COOKIE_NAME]: undefined,
        [ID_TOKEN_COOKIE_NAME]: undefined,
        [REFRESH_TOKEN_COOKIE_NAME]: undefined,
        [CSRF_COOKIE_NAME]: undefined,
      });
    }
  }

  // Allow public routes — but redirect logged-in users away from /login and /signup
  if (isPublic(pathname)) {
    if (jwt && (prefixMatches("/login", pathname) || pathname === "/signup")) {
      // `/signup/verify?token=…` stays accessible to authenticated users — a
      // user might verify a workspace in a browser where they're already
      // signed in to another tenant. But the bare `/signup` form bounces
      // them to /dashboard.
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    const response = NextResponse.next({
      request: { headers: buildRequestHeadersWithCookies(request, jwt, cookieHeader) },
    });
    if (refreshedSession) {
      applyRefreshedSession(response, request, refreshedSession);
    } else {
      ensureCsrfCookie(request, response, jwt);
    }
    return response;
  }

  // Protect authenticated routes — redirect to login with return URL
  if (isProtected(pathname) && !jwt) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    if (!refreshedSession && refreshToken) {
      clearSessionCookies(redirectResponse);
    }
    return redirectResponse;
  }

  const response = NextResponse.next({
    request: { headers: buildRequestHeadersWithCookies(request, jwt, cookieHeader) },
  });
  if (refreshedSession) {
    applyRefreshedSession(response, request, refreshedSession);
  } else {
    ensureCsrfCookie(request, response, jwt);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and image optimization:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
