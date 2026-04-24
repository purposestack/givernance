import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { TenantsTable } from "@/components/admin/tenants-table";
import { Button } from "@/components/ui/button";
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-text">{t("title")}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/admin/tenants/new">{t("createCta")}</Link>
        </Button>
      </header>

      <TenantsTable tenants={tenants} />
    </div>
  );
}
