import { type NextRequest, NextResponse } from "next/server";
import { isJwtExpired, JWT_COOKIE_NAME, jwtCookieOptions } from "@/lib/auth/session";

const CSRF_COOKIE_NAME = "csrf-token";

/** Where the proxy detours a full-page navigation to restore an expired session. */
const RESTORE_SESSION_PATH = "/api/auth/restore-session";

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
  // Issue #254: the platform-admin invitation accept page lives under
  // `/admin/platform-admins/accept` because it's adjacent to the
  // operator-side CRUD, but it's PUBLIC by design — invitees aren't
  // authenticated yet. Without this entry, `/admin` in
  // `PROTECTED_PREFIXES` (one line below) catches the path and bounces
  // the invitee to `/login`, losing the `?token=…` query and stranding
  // them with no password set. The `isPublic` check fires before
  // `isProtected`, so this entry takes precedence.
  "/admin/platform-admins/accept",
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

/**
 * Set the (non-httpOnly) CSRF double-submit cookie the first time an
 * authenticated session reaches the proxy without one. Normally minted at
 * callback / refresh time; this is the safety net for an authenticated
 * request that somehow arrives with a JWT but no CSRF cookie. Writes only
 * a *response* cookie — it never modifies request headers, so it does not
 * reintroduce the `x-middleware-request-*` override bloat issue #296
 * removed.
 */
function ensureCsrfCookie(request: NextRequest, response: NextResponse, jwt?: string) {
  if (!jwt || request.cookies.get(CSRF_COOKIE_NAME)?.value) {
    return;
  }
  response.cookies.set(CSRF_COOKIE_NAME, mintCsrfToken(), {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: jwtCookieOptions().maxAge,
  });
}

/**
 * Redirect a full-page navigation to `/api/auth/restore-session`, carrying
 * the originally-requested path so the restore route can land the user
 * back where they were headed once it has minted a fresh access token from
 * the `/api/auth`-scoped refresh cookie (issue #296).
 */
function redirectToRestore(request: NextRequest, pathname: string): NextResponse {
  const restoreUrl = new URL(RESTORE_SESSION_PATH, request.url);
  restoreUrl.searchParams.set("return", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(restoreUrl);
}

/**
 * Next.js 16 proxy (formerly `middleware`). Issue #296: this no longer
 * injects `Authorization` or re-writes the `cookie` header on every
 * request — both were redundant (the API reads the JWT from the
 * `givernance_jwt` cookie) and marked the headers "overridden", which
 * Next.js serialised into `x-middleware-request-*` headers that bloated
 * the request reaching Fastify past its 16 KB limit (431
 * `HPE_HEADER_OVERFLOW`). The steady-state path now returns
 * `NextResponse.next()` with the request headers untouched.
 *
 * Token refresh also moved out of the proxy: `refresh_token` is now scoped
 * to `/api/auth`, so the proxy can't read it. The client-side timer keeps
 * the access token fresh during an active session; for a full-page
 * navigation that arrives with an *expired* (or absent) JWT — a cold tab,
 * or the operator's session right after impersonation ends — the proxy
 * detours through `/api/auth/restore-session`, which performs the refresh
 * server-side and redirects onward (or to /login if the refresh token is
 * also gone).
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const jwt = request.cookies.get(JWT_COOKIE_NAME)?.value;
  const authenticated = Boolean(jwt) && !isJwtExpired(jwt);

  // Public routes — but redirect signed-in users away from /login and /signup.
  if (isPublic(pathname)) {
    if (authenticated && (prefixMatches("/login", pathname) || pathname === "/signup")) {
      // `/signup/verify?token=…` stays accessible to authenticated users — a
      // user might verify a workspace in a browser where they're already
      // signed in to another tenant. But the bare `/signup` form bounces
      // them to /dashboard.
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    const response = NextResponse.next();
    ensureCsrfCookie(request, response, jwt);
    return response;
  }

  // Protected routes: an absent or expired JWT detours through the
  // server-side restore route (which refreshes from the `/api/auth`-scoped
  // refresh cookie, or falls through to /login). A still-valid JWT — the
  // common case, kept fresh by the client silent-refresh timer — passes
  // straight through with headers untouched.
  if (isProtected(pathname) && !authenticated) {
    return redirectToRestore(request, pathname);
  }

  const response = NextResponse.next();
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
