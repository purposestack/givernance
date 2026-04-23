/**
 * Slugs reserved at the platform level — they cannot be used as tenant slugs
 * because they collide with Givernance platform routes or DNS-adjacent names.
 *
 * Keep this list **explicit** (not a regex). A future reviewer needs to be
 * able to answer "is `billing` reserved?" at a glance. ADR-016 / doc 22 §7.
 */
export const RESERVED_SLUGS: readonly string[] = Object.freeze([
  // Core platform routes
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "callback",
  "docs",
  "health",
  "healthz",
  "login",
  "logout",
  "mail",
  "metrics",
  "onboarding",
  "p",
  "public",
  "select-organization",
  "settings",
  "signup",
  "sso",
  "status",
  "support",
  "www",

  // Common squatting targets
  "dashboard",
  "home",
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

  // SEO / legal pages
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
 * character set) is the caller's responsibility — see `tenantSlug` validator.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUG_SET.has(slug.trim().toLowerCase());
}
