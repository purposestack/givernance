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

/** Authenticated user context extracted from JWT */
export interface AuthContext {
  userId: string;
  orgId: string;
  roles: string[];
  email: string;
}

/** Constituent type enum */
export type ConstituentType = "donor" | "volunteer" | "member" | "beneficiary" | "partner";

/** Supported currencies */
export type Currency = "EUR" | "GBP" | "CHF" | "SEK" | "NOK" | "DKK" | "PLN" | "CZK";
