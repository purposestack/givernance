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
  safeReturnToPath,
} from "@/lib/auth/keycloak";
import { logAuthEvent } from "@/lib/auth/log";
import { validateLoginHint } from "@/lib/auth/login-hint";
import { STEP_UP_ACR_VALUE } from "@/lib/auth/step-up";

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

  // Post-verify / post-accept redirect carries `?hint=<tenant-slug>` so KC
  // can route federated/SAML tenants straight to their IdP without an
  // extra picker click (issue #150). Forwarded as `kc_idp_hint`: KC
  // matches the alias to a configured IdP and redirects directly when
  // it exists, silently ignoring the hint otherwise — so non-federated
  // tenants are unaffected. Validated via the shared tenant-slug
  // checker so the punycode + reserved-slug rejects stay aligned with
  // signup. Rejected hints emit a warn log mirroring the
  // `auth.return_to.rejected` pattern below, so attacker probes are
  // visible on Cockpit instead of failing silently (PR #358 review m2).
  const url = new URL(request.url);
  const rawHint = url.searchParams.get("hint");
  const hint = validateLoginHint(rawHint);
  if (hint.kind === "valid") {
    params.set("kc_idp_hint", hint.slug);
  } else if (hint.kind === "rejected" && rawHint) {
    logAuthEvent("warn", "auth.login_hint.rejected", {
      raw: rawHint.slice(0, 256),
      reason: hint.reason,
    });
  }

  // Step-up MFA support (issue #250). The impersonation form redirects
  // here with `acr_values=2` + `prompt=login` to force a fresh MFA-backed
  // re-auth. Both params are pass-throughs to Keycloak — the realm's
  // browser-with-step-up flow + acr.loa.map handle the OTP prompt and
  // ACR claim mapping. Only allow-listed values are forwarded so a
  // malicious caller can't smuggle arbitrary OIDC params into the
  // upstream auth request. The literal acr value lives in step-up.ts so
  // a future LoA bump (`"3"`, `"high"`) lands in one place.
  const acrValues = url.searchParams.get("acr_values");
  const stepUpRequested = acrValues === STEP_UP_ACR_VALUE;
  if (stepUpRequested) {
    params.set("acr_values", STEP_UP_ACR_VALUE);
  }
  // `prompt=login` forces a fresh password challenge upstream. We only
  // honour it when `acr_values=2` is also present so it's coupled to a
  // legitimate step-up redirect (the impersonation form is the sole
  // caller). Letting `prompt=login` through in isolation lets a third-
  // party origin embed a bouncing redirect that re-prompts the user
  // every page load — annoying-only, but combined with #258's residual
  // risk (lazy TOTP enrolment) it raises the value of a forced re-auth
  // primer. Coupling them closes that vector. Multi-agent review I-1
  // (PR #251).
  const prompt = url.searchParams.get("prompt");
  if (prompt === "login" && stepUpRequested) {
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
  const rawReturnTo = url.searchParams.get("return_to");
  const returnTo = safeReturnToPath(rawReturnTo);
  if (rawReturnTo && !returnTo) {
    // Surface attempts to slip a cross-origin / malformed return_to so
    // an open-redirect probe is visible on Cockpit/Loki dashboards
    // instead of silently failing closed (multi-agent review Logs-3,
    // PR #251). We log the rejected raw value (truncated) — useful for
    // forensics, and not sensitive because the request was already
    // public.
    logAuthEvent("warn", "auth.return_to.rejected", {
      raw: rawReturnTo.slice(0, 256),
      reason: "not_same_origin_path",
    });
  }
  if (returnTo) {
    jar.set(OIDC_RETURN_TO_COOKIE, returnTo, returnToCookieOptions());
  }

  return NextResponse.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
}
