import { type NextRequest, NextResponse } from "next/server";

/**
 * JWT cookie name — must match the value in lib/auth/keycloak.ts.
 * Duplicated here because proxy runs in the Edge runtime and cannot
 * import from "server-only" modules.
 */
const JWT_COOKIE_NAME = "givernance_jwt";

/** Route prefixes that require authentication. */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/settings",
  "/contacts",
  "/constituents",
  "/donations",
  "/campaigns",
  "/grants",
  "/programs",
  "/volunteers",
  "/impact",
  "/communications",
  "/reports",
];

/** Route prefixes that are always public (auth pages, API callbacks, static assets). */
const PUBLIC_PREFIXES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/request-access",
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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const jwt = request.cookies.get(JWT_COOKIE_NAME)?.value;

  // Allow public routes — but redirect logged-in users away from /login
  if (isPublic(pathname)) {
    if (pathname.startsWith("/login") && jwt) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  // Protect authenticated routes — redirect to login with return URL
  if (isProtected(pathname) && !jwt) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
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
