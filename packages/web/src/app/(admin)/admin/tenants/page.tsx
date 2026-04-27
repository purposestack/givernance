import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { TenantsTable } from "@/components/admin/tenants-table";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import type {
  AdminTenantListResponse,
  AdminTenantSortField,
  AdminTenantSortOrder,
  AdminTenantSummary,
} from "@/services/TenantAdminService";

export const dynamic = "force-dynamic";

const TENANT_SORT_FIELDS = new Set<AdminTenantSortField>([
  "name",
  "status",
  "plan",
  "primaryDomain",
  "createdVia",
  "ownershipConfirmedAt",
  "createdAt",
  "updatedAt",
]);

function normalizeSort(value: string | undefined): AdminTenantSortField {
  if (value && TENANT_SORT_FIELDS.has(value as AdminTenantSortField)) {
    return value as AdminTenantSortField;
  }
  return "createdAt";
}

function normalizeOrder(value: string | undefined): AdminTenantSortOrder {
  return value === "asc" ? "asc" : "desc";
}

export default async function TenantListPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; order?: string }>;
}) {
  const search = await searchParams;
  const t = await getTranslations("admin.tenants.list");
  const api = await createServerApiClient();
  const sort = normalizeSort(search.sort);
  const order = normalizeOrder(search.order);

  let tenants: AdminTenantSummary[] = [];
  try {
    const params = new URLSearchParams({ sort, order });
    const res = await api.get<AdminTenantListResponse>(
      `/v1/superadmin/tenants?${params.toString()}`,
    );
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

      <TenantsTable tenants={tenants} sort={sort} order={order} />
    </div>
  );
}
