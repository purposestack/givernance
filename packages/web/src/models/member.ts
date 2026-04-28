/**
 * Tenant member — a row in the `users` table for the current tenant.
 *
 * Distinct from `Invitation` (`models/invitation.ts`): a `Member` is someone
 * who has accepted their invite and now holds a `users` row. The members
 * settings page renders both tables — accepted members on top, invitations
 * below — so an org_admin can correct a typo in a teammate's display name
 * or shift their role from a single screen.
 *
 * Issue #161; pagination added in PR #185 review PJD-6.
 */
import type { Pagination } from "@/models/constituent";

export type MemberRole = "org_admin" | "user" | "viewer";

export interface Member {
  id: string;
  orgId: string;
  /** Keycloak `sub` claim — used to identify the caller's own row. */
  keycloakId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  role: MemberRole;
  createdAt: string;
  updatedAt: string;
}

export interface MemberListQuery {
  page?: number;
  perPage?: number;
}

export interface MemberListResponse {
  data: Member[];
  pagination: Pagination;
}

export interface UpdateMemberInput {
  firstName?: string;
  lastName?: string;
  role?: MemberRole;
}

export interface UpdateMemberResponse {
  data: Member;
}
