/**
 * Slugs reserved at the platform level — they cannot be used as tenant slugs
 * because they collide with Givernance platform routes, DNS-adjacent names,
 * or third-party service subdomains that Givernance itself uses.
 *
 * Buckets (explicit for clarity, not enforced in code):
 *  1. **App routes** — every top-level route under `packages/web/src/app/**`
 *     and every Fastify module under `packages/api/src/modules/**`.
 *  2. **Auth / identity primitives** — `oauth`, `saml`, `scim`, …; and the
 *     IDNA punycode prefix is rejected separately in the validator.
 *  3. **Platform subdomains / infra** — names we already use for Keycloak,
 *     Grafana, Scaleway, etc., reserved for when we move to subdomain
 *     tenant scoping.
 *  4. **Safety tokens** — `null`, `undefined`, `true`, `false`, `me`, …
 *     to prevent bizarre URL-parsing bugs downstream.
 *
 * Keep this list **explicit** (not a regex). A future reviewer needs to be
 * able to answer "is `billing` reserved?" at a glance. ADR-016 / doc 22 §7.
 *
 * Adding entries: open a PR with a one-line rationale in the commit message;
 * duplicates are enforced by the test suite.
 */
export const RESERVED_SLUGS: readonly string[] = Object.freeze([
  // ─── App routes (current web + api surface) ──────────────────────────
  "admin",
  "api",
  "app",
  "auth",
  "audit",
  "billing",
  "callback",
  "campaigns",
  "constituents",
  "dashboard",
  "docs",
  "donations",
  "forgot-password",
  "health",
  "healthz",
  "home",
  "invitations",
  "login",
  "logout",
  "mail",
  "metrics",
  "onboarding",
  "p",
  "pledges",
  "public",
  "reports",
  "reset-password",
  "select-organization",
  "settings",
  "signup",
  "sso",
  "status",
  "support",
  "users",
  "www",

  // ─── Auth / identity primitives ──────────────────────────────────────
  "oauth",
  "oidc",
  "openid",
  "saml",
  "scim",
  "well-known",
  ".well-known",
  "jwks",

  // ─── Platform subdomains / third-party infra ─────────────────────────
  "keycloak",
  "grafana",
  "prometheus",
  "cockpit",
  "scaleway",
  "stripe",
  "mollie",
  "minio",
  "mailpit",
  "object-storage",
  "cdn",
  "assets",
  "static",
  "img",
  "images",
  "files",
  "upload",
  "uploads",
  "download",
  "downloads",
  "ws",
  "wss",
  "graphql",
  "rpc",
  "webhook",
  "webhooks",
  "dns",

  // ─── Safety tokens ───────────────────────────────────────────────────
  "me",
  "null",
  "undefined",
  "true",
  "false",
  "anonymous",
  "test",
  "tests",
  "beta",
  "staging",
  "prod",
  "production",
  "dev",
  "development",
  "internal",
  "system",
  "root",
  "superuser",
  "operator",

  // ─── SEO / legal pages ───────────────────────────────────────────────
  "about",
  "contact",
  "legal",
  "privacy",
  "terms",
  "cookies",
  "gdpr",
  "pricing",
  "blog",
  "press",
  "jobs",
  "careers",
]);

/** Lowercase set for O(1) membership checks. */
const RESERVED_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS);

/**
 * Returns `true` when `slug` clashes with a reserved platform slug. Input is
 * normalised to lowercase. Syntactic validity of the slug itself (length,
 * character set, IDNA punycode prefix) is the caller's responsibility — see
 * `validateTenantSlug`.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUG_SET.has(slug.trim().toLowerCase());
}
