/**
 * Shared cross-package constants. Kept in a package-separated entry point
 * (`@givernance/shared/constants`) so the web package can import them without
 * pulling the Drizzle schema (ADR-013 type boundary).
 */

export { isPersonalEmailDomain, PERSONAL_EMAIL_DOMAINS } from "./personal-email-domains";

export { isReservedSlug, RESERVED_SLUGS } from "./reserved-slugs";

export { DOMAIN_PATTERN, validateTenantDomain } from "./tenant-domain";
