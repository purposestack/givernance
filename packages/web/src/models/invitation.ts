import type { Pagination } from "@/models/constituent";

export type InvitationRole = "org_admin" | "user" | "viewer";
export type InvitationStatus = "pending" | "accepted" | "expired";

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: InvitationRole;
  invitedById: string | null;
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
  role?: InvitationRole;
}

export interface InvitationCreateResponse {
  data: Omit<Invitation, "status">;
}
