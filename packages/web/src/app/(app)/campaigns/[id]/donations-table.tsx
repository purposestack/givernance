"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Gift } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useTransition } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type DonationListRow, donationDonorName } from "@/models/donation";

interface DonationsTableProps {
  donations: DonationListRow[];
  pagination: DataTablePagination;
}

export function DonationsTable({ donations, pagination }: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const t = useTranslations("campaigns.detail.donations");

  const navigateToPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (page <= 1) {
        params.delete("page");
      } else {
        params.set("page", String(page));
      }
      const query = params.toString();
      startTransition(() => {
        router.push(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  const columns = useMemo<ColumnDef<DonationListRow>[]>(
    () => [
      {
        id: "donatedAt",
        accessorKey: "donatedAt",
        header: () => t("columns.date"),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.donatedAt, locale, "medium")}
          </span>
        ),
      },
      {
        id: "donor",
        header: () => t("columns.donor"),
        cell: ({ row }) => {
          const donorName = donationDonorName(row.original) ?? t("anonymousDonor");
          return (
            <Link
              href={`/donations/${row.original.id}`}
              onClick={(event) => event.stopPropagation()}
              className="font-medium text-on-surface hover:text-primary hover:underline"
            >
              {donorName}
            </Link>
          );
        },
      },
      {
        id: "reference",
        accessorKey: "paymentRef",
        header: () => t("columns.reference"),
        cell: ({ row }) => (
          <span className="text-on-surface-variant">
            {row.original.paymentRef ?? t("noReference")}
          </span>
        ),
      },
      {
        id: "amount",
        accessorKey: "amountCents",
        header: () => <span className="block text-right">{t("columns.amount")}</span>,
        cell: ({ row }) => (
          <span className="block text-right font-mono font-semibold tabular-nums text-on-surface">
            {formatCurrency(row.original.amountCents, locale, row.original.currency)}
          </span>
        ),
      },
    ],
    [locale, t],
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
        onRowClick={(row) => router.push(`/donations/${row.original.id}`)}
        emptyState={<EmptyState icon={Gift} title={t("title")} description={t("empty")} />}
      />
    </div>
  );
}
