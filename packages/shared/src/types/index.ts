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

/** Standard API error response */
export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Application-level user role */
export type UserRole = "org_admin" | "user" | "viewer";

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
}

/** Constituent type enum */
export type ConstituentType = "donor" | "volunteer" | "member" | "beneficiary" | "partner";

/** Supported currencies */
export type Currency = "EUR" | "GBP" | "CHF" | "SEK" | "NOK" | "DKK" | "PLN" | "CZK";
