import { type NextRequest, NextResponse } from "next/server";

/** Routes that require authentication */
const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/contacts", "/donations", "/campaigns"];

/** Routes that are always public (auth pages, API callbacks, static) */
const PUBLIC_PREFIXES = [
  "/login",
  "/forgot-password",
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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const jwt = request.cookies.get("givernance_jwt")?.value;

  // Allow public routes
  if (isPublic(pathname)) {
    // If already logged in and hitting /login, redirect to dashboard
    if (pathname.startsWith("/login") && jwt) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  // Protect authenticated routes
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
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
