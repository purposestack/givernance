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
