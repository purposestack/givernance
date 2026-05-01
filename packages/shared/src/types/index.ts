/** Shared TypeScript types used across all packages */

/** Pagination parameters for list endpoints */
export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Standard API success response wrapper */
export interface ApiResponse<T> {
  data: T;
  pagination?: Pagination;
  meta?: Record<string, unknown>;
}

/** Standard API error response (RFC 9457 Problem Details) */
export interface ApiError {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/** Application-level user role */
export type UserRole = "org_admin" | "user" | "viewer";

/** Two coexisting support-session modes — issue #24 / docs/19-impersonation.md */
export type ImpersonationModeName = "delegation" | "impersonation";

/**
 * Impersonation context surfaced from the JWT when an admin acts inside a
 * support session. `mode` discriminates the two coexisting flavours
 * (delegation = own-name with extended rights; impersonation = pure,
 * read-only-ish pretend-to-be-user). Both flavours carry the RFC 8693
 * `act.sub` claim, but middleware behaviour diverges on `mode`.
 */
export interface ImpersonationContext {
  sessionId: string;
  mode: ImpersonationModeName;
  reason: string;
  expiresAt: number;
}

/** Authenticated user context extracted from JWT */
export interface AuthContext {
  userId: string;
  orgId: string;
  roles: string[];
  email: string;
  /** Application-level role from JWT `role` claim */
  role?: UserRole;
  /** RFC 8693 §4.1 actor claim — present only on delegation/impersonation tokens */
  act?: { sub: string };
  /**
   * OIDC `auth_time` — seconds-epoch when the user actually authenticated
   * (vs `iat` which is when the token was minted). Used by the
   * impersonation start endpoint to enforce a step-up window (issue #24).
   */
  authTime?: number;
  /** OIDC `acr` — `"2"` ⇒ MFA-backed login. Used by the step-up check. */
  acr?: string;
  /**
   * Set when the request is authenticated through an impersonation token.
   * Drives mode-aware RBAC, audit double-attribution, and the write-block
   * for `mode === "impersonation"`.
   */
  impersonation?: ImpersonationContext;
}

/** Constituent type enum */
export type ConstituentType = "donor" | "volunteer" | "member" | "beneficiary" | "partner";

/** Supported currencies */
export type Currency = "EUR" | "GBP" | "CHF" | "SEK" | "NOK" | "DKK" | "PLN" | "CZK";
