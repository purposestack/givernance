import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PlatformAdminsFilters } from "@/components/admin/platform-admins-filters";
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
 * Super-admin-only list page for platform admins (issues #254 + #255 +
 * #260). Reads the four URL params the API supports — `sort`, `order`,
 * `q`, `includeDeleted` — server-side and forwards them onto the
 * `/v1/admin/platform-admins` GET. The filter controls (`q` +
 * `includeDeleted` toggle) live in the client `PlatformAdminsFilters`
 * component, which writes back to the URL via `router.replace` so the
 * server re-fetches on every change.
 */
export default async function PlatformAdminsListPage({
  searchParams,
}: {
  searchParams: Promise<{
    sort?: string;
    order?: string;
    q?: string;
    includeDeleted?: string;
  }>;
}) {
  const search = await searchParams;
  const t = await getTranslations("admin.platformAdmins.list");
  const api = await createServerApiClient();
  const sort = normalizeSort(search.sort);
  const order = normalizeOrder(search.order);
  const q = (search.q ?? "").trim();
  // Lenient parse on `?includeDeleted=` so a `?includeDeleted` (no
  // value, the URL-without-explicit-`true` form some browsers emit on
  // toggled checkboxes) lands as truthy. Anything else → false.
  const includeDeleted = search.includeDeleted === "true" || search.includeDeleted === "";

  let data: PlatformAdminListResponse["data"] | null = null;
  let total = 0;
  let fetchFailed = false;
  try {
    const params = new URLSearchParams({ sort, order, limit: "200" });
    if (q) params.set("q", q);
    if (includeDeleted) params.set("includeDeleted", "true");
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

      {/* ADR-035 rule A1 — header + filter bar above are static shell;
          only the content below (banner or table) enters at slot 0.
          Rows follow from slot 1 inside PlatformAdminsTable. */}
      <PlatformAdminsFilters initialQ={q} initialIncludeDeleted={includeDeleted} />

      {fetchFailed ? (
        <div
          role="alert"
          className="reveal-item flex items-start gap-3 rounded-2xl border border-error bg-error-container p-4 text-on-error-container"
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
