"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ShieldCheck } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useTransition } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { DataTable } from "@/components/ui/data-table";
import type {
  PlatformAdmin,
  PlatformAdminSortField,
  PlatformAdminSortOrder,
} from "@/models/platform-admin";

import { formatAdminDate } from "./tenant-admin-shared";

interface Props {
  admins: PlatformAdmin[];
  total: number;
  sort: PlatformAdminSortField;
  order: PlatformAdminSortOrder;
}

export function PlatformAdminsTable({ admins, total, sort, order }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("admin.platformAdmins.list");
  const [isPending, startTransition] = useTransition();

  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [sort, order],
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
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  const columns = useMemo<ColumnDef<PlatformAdmin>[]>(
    () => [
      {
        id: "lastName",
        accessorKey: "lastName",
        header: () => t("columns.name"),
        enableSorting: true,
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-on-surface">
              {row.original.firstName} {row.original.lastName}
            </p>
          </div>
        ),
      },
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        enableSorting: true,
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: () => t("columns.createdAt"),
        enableSorting: true,
        cell: ({ row }) => formatAdminDate(row.original.createdAt),
      },
      {
        id: "lastLoginAt",
        accessorKey: "lastLoginAt",
        header: () => t("columns.lastLoginAt"),
        enableSorting: true,
        cell: ({ row }) =>
          row.original.lastLoginAt
            ? formatAdminDate(row.original.lastLoginAt)
            : t("lastLoginNever"),
      },
      {
        id: "status",
        header: () => t("columns.status"),
        enableSorting: false,
        cell: ({ row }) => {
          const removed = row.original.deletedAt !== null;
          return (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                removed
                  ? "bg-error-container text-on-error-container"
                  : "bg-tertiary-container text-on-tertiary-container"
              }`}
            >
              {removed ? t("status.removed") : t("status.active")}
            </span>
          );
        },
      },
      // No actions column — the entire row is clickable via `onRowClick`
      // and navigates to the detail page (same pattern as `tenants-table`
      // when an admin opens a detail-only resource). Frontend review
      // M3/M4 dropped the redundant dropdown that duplicated the row click.
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={admins}
      pagination={{
        page: 1,
        perPage: total || admins.length || 1,
        total,
        totalPages: 1,
      }}
      onPageChange={() => {}}
      sorting={sorting}
      onSortingChange={onSortingChange}
      isPending={isPending}
      // ADR-035 rules A2/A3 — the table container is slot 0 of the
      // content cascade (container before content), rows follow from
      // slot 1. Entrance runs once per mount; search/sort round-trips
      // never replay it (rule B12) — same grammar as donations-table.
      className="reveal-item"
      animateEntrance
      entranceCascadeOffset={1}
      onRowClick={(row) => router.push(`/admin/platform-admins/${row.original.id}`)}
      emptyState={<EmptyState icon={ShieldCheck} title={t("empty")} />}
    />
  );
}
