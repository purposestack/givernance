"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Building2, Eye, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  AdminTenantSortField,
  AdminTenantSortOrder,
  AdminTenantSummary,
} from "@/services/TenantAdminService";

import {
  formatAdminDate,
  normalizeTenantToken,
  TenantOwnershipBadge,
  TenantStatusBadge,
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
  sort: AdminTenantSortField;
  order: AdminTenantSortOrder;
}

export function TenantsTable({ tenants, sort, order }: TenantsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("admin.tenants.list");

  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [order, sort],
  );

  const onSortingChange = useCallback(
    (nextSorting: SortingState) => {
      const [next] = nextSorting;
      const params = new URLSearchParams(searchParams.toString());
      if (!next) {
        params.delete("sort");
        params.delete("order");
      } else {
        params.set("sort", next.id);
        params.set("order", next.desc ? "desc" : "asc");
      }
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const columns = useMemo<ColumnDef<AdminTenantSummary>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: () => t("columns.name"),
        enableSorting: true,
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
        enableSorting: true,
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
        enableSorting: true,
      },
      {
        id: "primaryDomain",
        accessorKey: "primaryDomain",
        header: () => t("columns.primaryDomain"),
        enableSorting: true,
        cell: ({ row }) => <p className="text-on-surface">{row.original.primaryDomain ?? "—"}</p>,
      },
      {
        id: "createdVia",
        accessorKey: "createdVia",
        header: () => t("columns.createdVia"),
        enableSorting: true,
      },
      {
        id: "ownershipConfirmedAt",
        accessorKey: "ownershipConfirmedAt",
        header: () => t("columns.ownership"),
        enableSorting: true,
        cell: ({ row }) => (
          <TenantOwnershipBadge
            createdVia={row.original.createdVia}
            ownershipConfirmedAt={row.original.ownershipConfirmedAt}
            confirmedLabel={t("ownership.confirmed")}
            pendingLabel={t("ownership.pending")}
            notApplicableLabel={t("ownership.notApplicable")}
          />
        ),
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: () => t("columns.createdAt"),
        enableSorting: true,
        cell: ({ row }) => formatAdminDate(row.original.createdAt),
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: () => t("columns.updatedAt"),
        enableSorting: true,
        cell: ({ row }) => formatAdminDate(row.original.updatedAt),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("columns.actions") || "Actions"}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="justify-center"
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/admin/tenants/${row.original.id}`}>
                  <Eye size={16} aria-hidden="true" className="mr-2" />
                  {t("actions.view") || "Voir les détails"}
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
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
      sorting={sorting}
      onSortingChange={onSortingChange}
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
