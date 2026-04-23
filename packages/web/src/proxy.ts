import { type NextRequest, NextResponse } from "next/server";

/**
 * JWT cookie name — must match the value in lib/auth/keycloak.ts.
 * Duplicated here because proxy runs in the Edge runtime and cannot
 * import from "server-only" modules.
 */
const JWT_COOKIE_NAME = "givernance_jwt";
const CSRF_COOKIE_NAME = "csrf-token";
const CSRF_COOKIE_MAX_AGE_S = 8 * 60 * 60;

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
  "/request-access",
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

function ensureCsrfCookie(request: NextRequest, response: NextResponse, jwt?: string) {
  if (!jwt || request.cookies.get(CSRF_COOKIE_NAME)?.value) {
    return;
  }

  response.cookies.set(CSRF_COOKIE_NAME, mintCsrfToken(), {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: CSRF_COOKIE_MAX_AGE_S,
  });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const jwt = request.cookies.get(JWT_COOKIE_NAME)?.value;

  // Allow public routes — but redirect logged-in users away from /login and /signup
  if (isPublic(pathname)) {
    if (jwt && (prefixMatches("/login", pathname) || pathname === "/signup")) {
      // `/signup/verify?token=…` stays accessible to authenticated users — a
      // user might verify a workspace in a browser where they're already
      // signed in to another tenant. But the bare `/signup` form bounces
      // them to /dashboard.
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    const response = NextResponse.next({ request: { headers: buildRequestHeaders(request, jwt) } });
    ensureCsrfCookie(request, response, jwt);
    return response;
  }

  // Protect authenticated routes — redirect to login with return URL
  if (isProtected(pathname) && !jwt) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next({ request: { headers: buildRequestHeaders(request, jwt) } });
  ensureCsrfCookie(request, response, jwt);
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
