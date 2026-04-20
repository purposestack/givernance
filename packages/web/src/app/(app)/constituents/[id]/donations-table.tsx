"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Gift } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useTransition } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Donation } from "@/models/donation";

interface DonationsTableProps {
  donations: Donation[];
  pagination: DataTablePagination;
}

export function DonationsTable({ donations, pagination }: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const t = useTranslations("constituentDetail.donationsTab");

  const navigateToPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (page <= 1) {
        params.delete("donationsPage");
      } else {
        params.set("donationsPage", String(page));
      }
      const query = params.toString();
      startTransition(() => {
        router.push(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  const columns = useMemo<ColumnDef<Donation>[]>(
    () => [
      {
        id: "donatedAt",
        accessorKey: "donatedAt",
        header: () => t("columns.date"),
        cell: ({ row }) => (
          <span className="text-on-surface">{formatDate(row.original.donatedAt, locale)}</span>
        ),
      },
      {
        id: "amount",
        accessorKey: "amountCents",
        header: () => t("columns.amount"),
        cell: ({ row }) => (
          <span className="font-mono font-semibold text-on-surface">
            {formatCurrency(row.original.amountCents, locale, row.original.currency)}
          </span>
        ),
      },
      {
        id: "paymentMethod",
        accessorKey: "paymentMethod",
        header: () => t("columns.paymentMethod"),
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.paymentMethod ?? "—"}</span>
        ),
      },
      {
        id: "fiscalYear",
        accessorKey: "fiscalYear",
        header: () => t("columns.fiscalYear"),
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.fiscalYear}</span>
        ),
      },
    ],
    [t, locale],
  );

  return (
    <div
      className={cn("transition-opacity duration-normal", isPending ? "opacity-60" : "opacity-100")}
      aria-busy={isPending || undefined}
    >
      <DataTable
        columns={columns}
        data={donations}
        pagination={pagination}
        onPageChange={navigateToPage}
        emptyState={
          <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.description")} />
        }
      />
    </div>
  );
}
