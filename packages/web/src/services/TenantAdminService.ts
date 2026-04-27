import type { Locale } from "@givernance/shared/i18n";
import { createClientApiClient } from "@/lib/api/client-browser";

export interface AdminFirstAdminInvitation {
  id: string;
  email: string;
  status: "pending" | "accepted" | "expired";
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface AdminTenantSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  createdVia: string;
  verifiedAt: string | null;
  primaryDomain: string | null;
  keycloakOrgId: string | null;
  /**
   * BCP-47 default locale for users in this tenant. The first-admin
   * invite picker labels its "Use workspace default ({locale})" option
   * from this value. Issue #153 follow-up.
   */
  defaultLocale: Locale;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTenantDomain {
  id: string;
  domain: string;
  state: string;
  dnsTxtValue: string;
  verifiedAt: string | null;
  createdAt: string;
}

export interface AdminTenantUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  firstAdmin: boolean;
  provisionalUntil: string | null;
  lastVisitedAt: string | null;
}

export interface AdminTenantAuditEntry {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  userId: string | null;
  newValues: unknown;
  oldValues: unknown;
  createdAt: string;
}

export interface AdminTenantDetail {
  tenant: AdminTenantSummary;
  domains: AdminTenantDomain[];
  users: AdminTenantUser[];
  recentAudit: AdminTenantAuditEntry[];
  firstAdminInvitation: AdminFirstAdminInvitation | null;
}

export interface AdminTenantListResponse {
  data: AdminTenantSummary[];
}

export interface AdminTenantDetailResponse {
  data: AdminTenantDetail;
}

export type TenantLifecycleAction = "suspend" | "archive" | "activate";

export async function triggerTenantLifecycle(
  tenantId: string,
  action: TenantLifecycleAction,
  reason?: string,
): Promise<{ status: string }> {
  const api = createClientApiClient();
  return api.post<{ status: string }>(
    `/v1/superadmin/tenants/${encodeURIComponent(tenantId)}/lifecycle`,
    {
      action,
      reason: reason?.trim() ? reason.trim() : undefined,
    },
  );
}

export type TenantPlan = "starter" | "pro" | "enterprise";

export interface CreateEnterpriseTenantInput {
  name: string;
  slug: string;
  plan?: TenantPlan;
}

export interface CreateEnterpriseTenantResult {
  tenantId: string;
  slug: string;
  keycloakOrgId: string;
  status: string;
}

export async function createEnterpriseTenant(
  input: CreateEnterpriseTenantInput,
): Promise<CreateEnterpriseTenantResult> {
  const api = createClientApiClient();
  const res = await api.post<{ data: CreateEnterpriseTenantResult }>(
    "/v1/superadmin/tenants",
    input,
  );
  return res.data;
}

// ─── First-admin invitation (super-admin) ──────────────────────────────────

export interface InviteFirstAdminResult {
  invitationId: string;
  invitationToken: string;
  expiresAt: string;
}

/**
 * Build the URL the invitee uses to accept their invitation. Surfaced as
 * the copy-link fallback on the FirstAdminCard until the email worker
 * (#145) ships. Mirrors the host-resolution policy from `new-tenant-form`
 * so white-label deployments don't surface `givernance.app/`.
 */
export function buildInviteAcceptUrl(token: string): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  const base = raw && raw.length > 0 ? raw.replace(/\/$/, "") : "";
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
}

export async function inviteFirstAdmin(
  tenantId: string,
  email: string,
  /**
   * Optional super-admin pre-pick of the welcome-email language.
   * `null` is sent on the wire to mean "follow the tenant default";
   * `undefined` is omitted from the request entirely (default behaviour
   * — same fallback). Issue #153 follow-up.
   */
  locale: Locale | null | undefined = undefined,
): Promise<InviteFirstAdminResult> {
  const api = createClientApiClient();
  const body: Record<string, unknown> = { email: email.trim().toLowerCase() };
  if (locale !== undefined) body.locale = locale;
  const res = await api.post<{ data: InviteFirstAdminResult }>(
    `/v1/superadmin/tenants/${encodeURIComponent(tenantId)}/first-admin-invitations`,
    body,
  );
  return res.data;
}

export async function resendFirstAdminInvitation(
  tenantId: string,
  invitationId: string,
): Promise<InviteFirstAdminResult> {
  const api = createClientApiClient();
  const res = await api.post<{ data: InviteFirstAdminResult }>(
    `/v1/superadmin/tenants/${encodeURIComponent(tenantId)}/first-admin-invitations/${encodeURIComponent(
      invitationId,
    )}/resend`,
  );
  return res.data;
}

export async function cancelFirstAdminInvitation(
  tenantId: string,
  invitationId: string,
): Promise<void> {
  const api = createClientApiClient();
  await api.delete<void>(
    `/v1/superadmin/tenants/${encodeURIComponent(tenantId)}/first-admin-invitations/${encodeURIComponent(
      invitationId,
    )}`,
  );
}
