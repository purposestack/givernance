"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Eye, MoreHorizontal, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useTransition } from "react";

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
      {
        id: "actions",
        header: () => <span className="sr-only">{t("columns.actions")}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="justify-center">
                <MoreHorizontal size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/admin/platform-admins/${row.original.id}`}>
                  <Eye size={16} aria-hidden="true" className="mr-2" />
                  {t("columns.actions")}
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
      onRowClick={(row) => router.push(`/admin/platform-admins/${row.original.id}`)}
      emptyState={<EmptyState icon={ShieldCheck} title={t("empty")} />}
    />
  );
}
