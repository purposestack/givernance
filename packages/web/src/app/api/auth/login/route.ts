import { isSupportedLocale } from "@givernance/shared/i18n";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  APP_URL,
  AUTH_ENDPOINT,
  generateCodeChallenge,
  generateRandom,
  KEYCLOAK_CLIENT_ID,
  OIDC_NONCE_COOKIE,
  OIDC_RETURN_TO_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
  oidcFlowCookieOptions,
  returnToCookieOptions,
} from "@/lib/auth/keycloak";
import { STEP_UP_ACR_VALUE } from "@/lib/auth/step-up";

/**
 * Same-origin path validator for the OIDC `return_to` parameter (issue
 * #250). Only same-origin paths are honoured — never an absolute host
 * or scheme — so a malicious caller can't craft
 * `/api/auth/login?return_to=https://evil.example` (or
 * `?return_to=/%2fevil.example` / `/%5cevil.example`) and turn the
 * callback into an open-redirect oracle.
 *
 * Validation strategy: parse via `new URL(raw, APP_URL)` so the URL
 * parser's normalisation does the heavy lifting (decodes percent-
 * encoded `/` and `\`, resolves protocol-relative `//host`, rejects
 * `javascript:` etc.), then compare the resolved origin to APP_URL's
 * origin. An earlier draft used a hand-rolled `startsWith("//")`
 * check, which review caught as bypassable via percent-encoding.
 */
function safeReturnToPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  // Reject control chars / CRLF / null bytes — defence-in-depth against
  // header smuggling if the value were ever echoed in a Set-Cookie or
  // Location header without re-encoding.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit defence-in-depth filter (CRLF / null-byte smuggling)
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  let resolved: URL;
  let appOrigin: URL;
  try {
    resolved = new URL(raw, APP_URL);
    appOrigin = new URL(APP_URL);
  } catch {
    return null;
  }
  if (resolved.origin !== appOrigin.origin) return null;
  // Only return the resolved path (no host/scheme echo) so the cookie
  // value is the path the callback expects — never an absolute URL.
  return resolved.pathname + resolved.search + resolved.hash;
}

/**
 * Extracts the Keycloak Organization alias from the request Host header.
 *
 * Pattern 1 (subdomain-first): each tenant runs on its own subdomain
 * (e.g. asso-x.givernance.eu). The subdomain is used as the `kc_org`
 * hint so Keycloak applies the org's custom theme before the user even
 * types their credentials.
 *
 * Returns null for:
 * - localhost / single-part hostnames (local dev — no subdomain)
 * - known non-org subdomains: www, app, api, admin, staging, preview, dev, auth
 * - in production: any hostname not ending in a trusted domain suffix to
 *   prevent X-Forwarded-Host spoofing from poisoning the kc_org hint
 */
function extractOrgAlias(host: string): string | null {
  const hostname = host.split(":")[0]?.toLowerCase() ?? ""; // strip port
  const parts = hostname.split(".");
  if (parts.length < 3) return null; // no subdomain (localhost, etc.)

  const subdomain = parts[0] ?? "";
  if (!subdomain) return null;

  const NON_ORG = new Set(["www", "app", "api", "admin", "staging", "preview", "dev", "auth"]);
  if (NON_ORG.has(subdomain)) return null;

  // M2: In production, only accept org aliases from known domains to prevent
  // X-Forwarded-Host spoofing from injecting an arbitrary kc_org value.
  if (process.env.NODE_ENV === "production") {
    const TRUSTED_SUFFIXES = [".givernance.org", ".givernance.eu"];
    const hostnameWithDot = `.${hostname}`;
    if (!TRUSTED_SUFFIXES.some((s) => hostnameWithDot.endsWith(s))) return null;
  }

  return subdomain;
}

/**
 * GET /api/auth/login
 *
 * Redirects the browser to the Keycloak authorization endpoint to begin
 * the OIDC Authorization Code flow with PKCE (S256), state, and nonce.
 *
 * Security:
 * - `state` prevents CSRF login attacks (validated in callback)
 * - `code_verifier`/`code_challenge` (PKCE S256) prevents authorization code interception
 * - `nonce` binds the ID token to this specific authentication request
 * - All three values stored in httpOnly cookies for callback validation
 *
 * Theming (Pattern 1 — subdomain-first):
 * - Reads the Host / X-Forwarded-Host header to derive the org alias
 * - Passes `kc_org=<alias>` so Keycloak resolves the Organization and
 *   injects per-org CSS variables (theme_primary_color, logo_url) into
 *   the login page before the user authenticates.
 */
export async function GET(request: NextRequest) {
  const state = generateRandom();
  const nonce = generateRandom();
  const codeVerifier = generateRandom();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const orgAlias = extractOrgAlias(host);

  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/auth/callback`,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  // Pass the org alias so Keycloak applies per-org theming and scopes the
  // session to the correct Organization. No-op in local dev (no subdomain).
  if (orgAlias) {
    params.set("kc_org", orgAlias);
  }

  // Step-up MFA support (issue #250). The impersonation form redirects
  // here with `acr_values=2` + `prompt=login` to force a fresh MFA-backed
  // re-auth. Both params are pass-throughs to Keycloak — the realm's
  // browser-with-step-up flow + acr.loa.map handle the OTP prompt and
  // ACR claim mapping. Only allow-listed values are forwarded so a
  // malicious caller can't smuggle arbitrary OIDC params into the
  // upstream auth request. The literal acr value lives in step-up.ts so
  // a future LoA bump (`"3"`, `"high"`) lands in one place.
  const url = new URL(request.url);
  const acrValues = url.searchParams.get("acr_values");
  if (acrValues === STEP_UP_ACR_VALUE) {
    params.set("acr_values", STEP_UP_ACR_VALUE);
  }
  const prompt = url.searchParams.get("prompt");
  // Only `login` is forwarded. A caller could craft `?prompt=login` to
  // force re-auth on a normal user — annoying but not a security hole;
  // any other value (`none`, `consent`, `select_account`) is silently
  // dropped to keep the upstream auth request clean.
  if (prompt === "login") {
    params.set("prompt", "login");
  }

  // Drive the Keycloak login page language from the app's selected locale.
  // Priority: ?locale query param (set by the /login page picker) → NEXT_LOCALE
  // cookie (persisted preference). Keycloak sets its own KEYCLOAK_LOCALE cookie
  // from this hint, so the user never sees a second language picker on the
  // credentials page.
  const jar = await cookies();
  const localeParam = new URL(request.url).searchParams.get("locale");
  const cookieLocale = jar.get("NEXT_LOCALE")?.value;
  const kcLocale = isSupportedLocale(localeParam)
    ? localeParam
    : isSupportedLocale(cookieLocale)
      ? cookieLocale
      : null;
  if (kcLocale) {
    params.set("kc_locale", kcLocale);
  }

  // Store OIDC flow params in httpOnly cookies for validation in callback
  const opts = oidcFlowCookieOptions();
  jar.set(OIDC_STATE_COOKIE, state, opts);
  jar.set(OIDC_VERIFIER_COOKIE, codeVerifier, opts);
  jar.set(OIDC_NONCE_COOKIE, nonce, opts);

  // Persist the post-callback redirect target across the OIDC round-trip
  // (issue #250). Same 5-min TTL as the other flow cookies — if the user
  // doesn't complete re-auth in time, the cookie expires and the callback
  // falls back to its default landing page (/select-organization).
  // Validated as a same-origin path; nothing else is accepted.
  //
  // Always clear any stale value first: if the operator started step-up,
  // abandoned it, and triggered a fresh non-step-up login within the 5-min
  // TTL, the previous return_to would otherwise still bounce them after
  // re-auth instead of the default landing page (review N-2).
  jar.delete(OIDC_RETURN_TO_COOKIE);
  const returnTo = safeReturnToPath(url.searchParams.get("return_to"));
  if (returnTo) {
    jar.set(OIDC_RETURN_TO_COOKIE, returnTo, returnToCookieOptions());
  }

  return NextResponse.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
}
