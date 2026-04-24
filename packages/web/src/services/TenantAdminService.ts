import { createClientApiClient } from "@/lib/api/client-browser";

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
