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
const PROTECTED_PREFIXES = ["/dashboard", "/settings"];

/** Route prefixes that are always public (auth pages, API callbacks, static assets). */
const PUBLIC_PREFIXES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/request-access",
  "/p",
  "/api/auth",
  "/_next",
  "/favicon.ico",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
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

  // Allow public routes — but redirect logged-in users away from /login
  if (isPublic(pathname)) {
    if (pathname.startsWith("/login") && jwt) {
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
