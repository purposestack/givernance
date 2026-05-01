/**
 * Browser-safe constants for the support-session subsystem (issue #24).
 *
 * Lives outside `schema/` because TypeBox validators referencing this list
 * need to be importable from web Client Components — the Drizzle schema
 * pulls in `pg-core` which is server-only.
 */

export const IMPERSONATION_MODE_VALUES = ["delegation", "impersonation"] as const;
export type ImpersonationMode = (typeof IMPERSONATION_MODE_VALUES)[number];

export const IMPERSONATION_END_REASON_VALUES = [
  "manual",
  "expired",
  "revoked",
  "switched",
] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASON_VALUES)[number];

/**
 * Sentinel tenant id for the seeded platform organization that hosts
 * super-admin users (`infra/keycloak/realm-givernance.json` — see the
 * `platform` Organization). Used by the impersonation service to refuse
 * starting a session against a target who belongs to the platform tenant
 * — that's the structural barrier against operator → operator nesting.
 */
export const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-0000000000a1";
