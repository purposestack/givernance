import { getTranslations } from "next-intl/server";

import { TenantsTable } from "@/components/admin/tenants-table";
import { createServerApiClient } from "@/lib/api/client-server";
import type { AdminTenantListResponse, AdminTenantSummary } from "@/services/TenantAdminService";

export const dynamic = "force-dynamic";

export default async function TenantListPage() {
  const t = await getTranslations("admin.tenants.list");
  const api = await createServerApiClient();

  let tenants: AdminTenantSummary[] = [];
  try {
    const res = await api.get<AdminTenantListResponse>("/v1/superadmin/tenants");
    tenants = res.data;
  } catch {
    tenants = [];
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-heading text-2xl text-text">{t("title")}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
      </header>

      <TenantsTable tenants={tenants} />
    </div>
  );
}
