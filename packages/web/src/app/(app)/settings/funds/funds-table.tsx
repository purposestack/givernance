"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { PiggyBank } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import { formatDate } from "@/lib/format";
import type { Fund, FundType } from "@/models/fund";

const FUND_TYPES = new Set<FundType>(["restricted", "unrestricted"]);

const TYPE_VARIANTS: Record<FundType, "warning" | "info"> = {
  restricted: "warning",
  unrestricted: "info",
};

interface FundsTableProps {
  funds: Fund[];
  pagination: DataTablePagination;
}

function isFundType(value: string): value is FundType {
  return FUND_TYPES.has(value as FundType);
}

export function FundsTable({ funds, pagination }: FundsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("settings.funds");

  const navigateToPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (page <= 1) {
        params.delete("page");
      } else {
        params.set("page", String(page));
      }
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const columns = useMemo<ColumnDef<Fund>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: () => t("columns.name"),
        enableSorting: true,
        cell: ({ row }) => <span className="font-medium text-on-surface">{row.original.name}</span>,
      },
      {
        id: "type",
        accessorKey: "type",
        header: () => t("columns.type"),
        enableSorting: true,
        cell: ({ row }) => {
          const type = String(row.original.type);
          if (!isFundType(type)) {
            return <Badge variant="neutral">{type}</Badge>;
          }
          return <Badge variant={TYPE_VARIANTS[type]}>{t(`types.${type}`)}</Badge>;
        },
      },
      {
        id: "description",
        accessorFn: (row) => row.description ?? "",
        header: () => t("columns.description"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="line-clamp-2 max-w-xl text-on-surface-variant">
            {row.original.description?.trim() || t("descriptionEmpty")}
          </span>
        ),
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: () => t("columns.createdAt"),
        enableSorting: true,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.createdAt, locale, "short")}
          </span>
        ),
      },
    ],
    [locale, t],
  );

  return (
    <DataTable
      columns={columns}
      data={funds}
      pagination={pagination}
      onPageChange={navigateToPage}
      emptyState={
        <EmptyState
          icon={PiggyBank}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      }
    />
  );
}
