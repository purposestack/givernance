import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PlatformAdminsTable } from "@/components/admin/platform-admins-table";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import type {
  PlatformAdminListResponse,
  PlatformAdminSortField,
  PlatformAdminSortOrder,
} from "@/models/platform-admin";

export const dynamic = "force-dynamic";

const SORT_FIELDS = new Set<PlatformAdminSortField>([
  "lastName",
  "email",
  "createdAt",
  "lastLoginAt",
]);

function normalizeSort(value: string | undefined): PlatformAdminSortField {
  if (value && SORT_FIELDS.has(value as PlatformAdminSortField)) {
    return value as PlatformAdminSortField;
  }
  return "createdAt";
}

function normalizeOrder(value: string | undefined): PlatformAdminSortOrder {
  return value === "asc" ? "asc" : "desc";
}

export default async function PlatformAdminsListPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; order?: string; q?: string; includeDeleted?: string }>;
}) {
  const search = await searchParams;
  const t = await getTranslations("admin.platformAdmins.list");
  const api = await createServerApiClient();
  const sort = normalizeSort(search.sort);
  const order = normalizeOrder(search.order);
  const includeDeleted = search.includeDeleted === "true";

  let data: PlatformAdminListResponse["data"] = [];
  let total = 0;
  try {
    const params = new URLSearchParams({
      sort,
      order,
      ...(search.q ? { q: search.q } : {}),
      ...(includeDeleted ? { includeDeleted: "true" } : {}),
      limit: "200",
    });
    const res = await api.get<PlatformAdminListResponse>(
      `/v1/admin/platform-admins?${params.toString()}`,
    );
    data = res.data;
    total = res.meta.total;
  } catch {
    data = [];
    total = 0;
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-text">{t("title")}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/admin/platform-admins/new">{t("createCta")}</Link>
        </Button>
      </header>

      <PlatformAdminsTable admins={data} total={total} sort={sort} order={order} />
    </div>
  );
}
