/**
 * Shared types for the support-session subsystem (issue #24).
 *
 * The two coexisting modes have distinct semantics — keep the discriminator
 * named `mode` (not `kind` or `type`) so it grep-matches the audit_logs
 * column and the JWT claim name.
 */

import type { ImpersonationModeName } from "@givernance/shared/types";

export type { ImpersonationModeName };

/**
 * App-layer impersonation JWT payload. Mirrors the shape Keycloak Token
 * Exchange will emit once the realm Script Mapper is deployed
 * (`infra/keycloak/mappers/impersonation-act-mapper.js`), so both paths
 * surface identical claims to the auth plugin.
 */
export interface ImpersonationTokenClaims {
  /** RFC 8693 §4.1 — effective subject (the target user's Keycloak `sub`). */
  sub: string;
  /** Target tenant id — drives RLS context. */
  org_id: string;
  /** Target user's app-level role; used for RBAC decisions in BOTH modes. */
  role: string;
  /** Target user's email — needed by audit and logger. */
  email: string;
  /** RFC 8693 §4.1 — actor delegated from. Always set on impersonation tokens. */
  act: { sub: string };
  /** Coexisting modes — see docs/19-impersonation.md. */
  imp_mode: ImpersonationModeName;
  /** FK to impersonation_sessions.id — shared across audit + Redis lookup. */
  imp_session_id: string;
  /**
   * Operator-provided reason. Carried in the JWT so audit + logger can
   * surface it without hitting Redis on every request.
   */
  imp_reason: string;
  /**
   * Roles array — drives `requireSuperAdmin` etc.
   *  - delegation:    operator's super_admin retained ⇒ ["super_admin"]
   *  - impersonation: operator's super_admin stripped ⇒ target user's roles
   * The auth plugin reads this verbatim into AuthContext.roles.
   */
  realm_access: { roles: string[] };
  iat: number;
  exp: number;
  /**
   * Distinct issuer string from Keycloak's. Lets the auth plugin route
   * impersonation tokens through `verifyImpersonationToken` without
   * accidentally feeding them through the realm JWKS.
   */
  iss: "givernance-impersonation";
  /** JWT id — used to revoke a session via Redis blocklist. */
  jti: string;
}

export interface ActiveSessionRedisRecord {
  sessionId: string;
  mode: ImpersonationModeName;
  impersonatorKeycloakId: string;
  targetKeycloakId: string;
  targetOrgId: string;
  targetRole: string;
  reason: string;
  expiresAt: number;
  jti: string;
}
