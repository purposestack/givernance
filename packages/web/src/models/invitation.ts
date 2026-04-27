import type { Locale } from "@givernance/shared/i18n";
import type { Pagination } from "@/models/constituent";

export type InvitationRole = "org_admin" | "user" | "viewer";
export type InvitationStatus = "pending" | "accepted" | "expired";

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: InvitationRole;
  invitedById: string | null;
  /**
   * Display name of the inviter ("First Last"). Null when the inviter row
   * was deleted or the invitation came from the super-admin seeding path.
   * Only populated by the list endpoint; the create endpoint omits it.
   */
  invitedByName?: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
  status: InvitationStatus;
}

export interface InvitationListQuery {
  page?: number;
  perPage?: number;
}

export interface InvitationListResponse {
  data: Invitation[];
  pagination: Pagination;
}

export interface InvitationCreateInput {
  email: string;
  firstName?: string;
  lastName?: string;
  role?: InvitationRole;
  /**
   * Optional BCP-47 locale picked by the inviting org_admin. When set,
   * the welcome email goes out in this language and the accept-form
   * locale picker pre-selects it. Omit / null = use the tenant default
   * (issue #153 follow-up).
   */
  locale?: Locale | null;
}

export interface InvitationCreateResponse {
  data: Omit<Invitation, "status">;
}
