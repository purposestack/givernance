"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { DataTable } from "@/components/ui/data-table";
import type { AdminTenantSummary } from "@/services/TenantAdminService";

import {
  formatAdminDate,
  normalizeTenantToken,
  TenantStatusBadge,
  TenantVerificationBadge,
} from "./tenant-admin-shared";

function tenantStatusLabel(
  t: (key: "statuses.active" | "statuses.suspended" | "statuses.archived") => string,
  status: string,
): string {
  const normalized = normalizeTenantToken(status);
  if (normalized === "active") return t("statuses.active");
  if (normalized === "suspended") return t("statuses.suspended");
  if (normalized === "archived") return t("statuses.archived");
  return status;
}

interface TenantsTableProps {
  tenants: AdminTenantSummary[];
}

export function TenantsTable({ tenants }: TenantsTableProps) {
  const router = useRouter();
  const t = useTranslations("admin.tenants.list");

  const columns = useMemo<ColumnDef<AdminTenantSummary>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: () => t("columns.name"),
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-on-surface">{row.original.name}</p>
            <p className="text-xs text-on-surface-variant">{row.original.slug}</p>
          </div>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        cell: ({ row }) => (
          <TenantStatusBadge
            status={row.original.status}
            label={tenantStatusLabel(t, row.original.status)}
          />
        ),
      },
      {
        id: "plan",
        accessorKey: "plan",
        header: () => t("columns.plan"),
      },
      {
        id: "domain",
        accessorKey: "primaryDomain",
        header: () => t("columns.primaryDomain"),
        cell: ({ row }) => (
          <div className="space-y-1">
            <p className="text-on-surface">{row.original.primaryDomain ?? "—"}</p>
            <TenantVerificationBadge
              verifiedAt={row.original.verifiedAt}
              verifiedLabel={t("verification.verified")}
              pendingLabel={t("verification.pending")}
            />
          </div>
        ),
      },
      {
        id: "createdVia",
        accessorKey: "createdVia",
        header: () => t("columns.createdVia"),
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: () => t("columns.updatedAt"),
        cell: ({ row }) => formatAdminDate(row.original.updatedAt),
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={tenants}
      pagination={{
        page: 1,
        perPage: tenants.length || 1,
        total: tenants.length,
        totalPages: 1,
      }}
      onPageChange={() => {}}
      onRowClick={(row) => router.push(`/admin/tenants/${row.original.id}`)}
      emptyState={
        <EmptyState
          icon={Building2}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      }
    />
  );
}
