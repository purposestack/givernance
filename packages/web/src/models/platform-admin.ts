/**
 * Platform-admin row exposed by `/v1/admin/platform-admins` (issue #254).
 *
 * Distinct from `Member` (tenant-scoped users): platform admins are
 * Givernance staff with no tenant binding (ADR-022). The web UI surfaces
 * them only inside the back-office (super-admin only) — no tenant member
 * is ever a platform admin and vice versa.
 */

export interface PlatformAdmin {
  id: string;
  /** Keycloak `sub`; null for soft-deleted rows whose KC user has been removed. */
  keycloakId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  /** ISO timestamp; null until the admin first signs in (post-#254 follow-up). */
  lastLoginAt: string | null;
  /** ISO timestamp when the admin was soft-deleted; null for active rows. */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PlatformAdminSortField = "lastName" | "email" | "createdAt" | "lastLoginAt";
export type PlatformAdminSortOrder = "asc" | "desc";

export interface PlatformAdminListQuery {
  q?: string;
  includeDeleted?: boolean;
  sort?: PlatformAdminSortField;
  order?: PlatformAdminSortOrder;
  limit?: number;
  offset?: number;
}

export interface PlatformAdminListResponse {
  data: PlatformAdmin[];
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
}

export interface PlatformAdminDetailResponse {
  data: PlatformAdmin;
}

export interface CreatePlatformAdminInput {
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Response shape from `POST /v1/admin/platform-admins` (issue #254
 * fix-commit 4 refactor). The endpoint inserts an invitation row and
 * sends an email; the actual `platform_admins` row lands at accept time.
 * The UI renders "invitation sent" from this — it does NOT have a real
 * admin id to link to.
 */
export interface PlatformAdminInvitationSummary {
  invitationId: string;
  email: string;
  firstName: string;
  lastName: string;
  expiresAt: string;
}

export interface UpdatePlatformAdminInput {
  firstName: string;
  lastName: string;
}
