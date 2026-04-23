const CSRF_COOKIE_NAME = "csrf-token";
const CSRF_HEADER_NAME = "X-CSRF-Token";

function isBrowser(): boolean {
  return typeof document !== "undefined";
}

export function getCsrfCookieName(): string {
  return CSRF_COOKIE_NAME;
}

export function getCsrfHeaderName(): string {
  return CSRF_HEADER_NAME;
}

export function readCsrfTokenFromDocumentCookie(): string | undefined {
  if (!isBrowser()) return undefined;

  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const entry of document.cookie.split(";")) {
    const cookie = entry.trim();
    if (!cookie.startsWith(prefix)) continue;

    const value = cookie.slice(prefix.length);
    return value ? decodeURIComponent(value) : undefined;
  }

  return undefined;
}

export function buildCsrfCookieOptions(maxAge: number) {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}
