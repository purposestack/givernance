import type { ApiClient } from "@/lib/api";
import type { Tenant, TenantResponse, TenantUpdateInput } from "@/models/tenant";

export const TenantService = {
  async getTenant(client: ApiClient, orgId: string): Promise<Tenant> {
    const response = await client.get<TenantResponse>(
      `/v1/admin/tenants/${encodeURIComponent(orgId)}`,
    );
    return response.data;
  },

  async updateTenant(client: ApiClient, orgId: string, input: TenantUpdateInput): Promise<Tenant> {
    const response = await client.put<TenantResponse>(
      `/v1/admin/tenants/${encodeURIComponent(orgId)}`,
      input,
    );
    return response.data;
  },
};
