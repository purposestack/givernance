import { AlertTriangle } from "lucide-react";
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

/**
 * Super-admin-only list page for platform admins (issue #254). Search +
 * include-deleted toggle UI are deferred to a follow-up — the API
 * supports both, but until the UI ships there's no point reading the
 * params from the URL (frontend review M2 — drop dead plumbing).
 */
export default async function PlatformAdminsListPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; order?: string }>;
}) {
  const search = await searchParams;
  const t = await getTranslations("admin.platformAdmins.list");
  const api = await createServerApiClient();
  const sort = normalizeSort(search.sort);
  const order = normalizeOrder(search.order);

  let data: PlatformAdminListResponse["data"] | null = null;
  let total = 0;
  let fetchFailed = false;
  try {
    const params = new URLSearchParams({ sort, order, limit: "200" });
    const res = await api.get<PlatformAdminListResponse>(
      `/v1/admin/platform-admins?${params.toString()}`,
    );
    data = res.data;
    total = res.meta.total;
  } catch {
    // Frontend review M1: a fetch failure rendered as an empty list
    // ("No platform admins yet") was misleading and dangerous on a
    // staff-management page. Distinct error banner instead.
    fetchFailed = true;
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-on-surface">{t("title")}</h1>
          <p className="mt-1 text-sm text-on-surface-variant">{t("subtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/admin/platform-admins/new">{t("createCta")}</Link>
        </Button>
      </header>

      {fetchFailed ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-error bg-error-container p-4 text-on-error-container"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
          <p className="text-sm">{t("fetchFailed")}</p>
        </div>
      ) : (
        <PlatformAdminsTable admins={data ?? []} total={total} sort={sort} order={order} />
      )}
    </div>
  );
}
