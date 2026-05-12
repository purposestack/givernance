/**
 * Shared cross-package constants. Kept in a package-separated entry point
 * (`@givernance/shared/constants`) so the web package can import them without
 * pulling the Drizzle schema (ADR-013 type boundary).
 */

export { resolveCountryName } from "./country-names";
export {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_REGISTRY,
  type FeatureFlagKey,
} from "./feature-flags";
export {
  IMPERSONATION_END_REASON_VALUES,
  IMPERSONATION_MODE_VALUES,
  type ImpersonationEndReason,
  type ImpersonationMode,
} from "./impersonation";
export { KEYCLOAK_DEFAULT_CLIENT_ID } from "./keycloak";
export { assertSafeOrgAttributes, SAFE_ORG_ATTRIBUTES } from "./keycloak-org-attributes";
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";
export { isPersonalEmailDomain, PERSONAL_EMAIL_DOMAINS } from "./personal-email-domains";
export { PINO_REDACT_PATHS } from "./pino-redact";
export { isReservedSlug, RESERVED_SLUGS } from "./reserved-slugs";
export { DOMAIN_PATTERN, validateTenantDomain } from "./tenant-domain";
