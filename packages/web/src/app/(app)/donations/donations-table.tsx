"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Gift } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import { formatCurrency, formatDate } from "@/lib/format";
import { type DonationListRow, donationDonorName, type ReceiptStatus } from "@/models/donation";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const RECEIPT_VARIANTS: Record<ReceiptStatus, BadgeVariant> = {
  generated: "success",
  pending: "warning",
  failed: "error",
};

interface DonationsTableProps {
  donations: DonationListRow[];
  pagination: DataTablePagination;
}

export function DonationsTable({ donations, pagination }: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("donations");

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

  const columns = useMemo<ColumnDef<DonationListRow>[]>(
    () => [
      {
        id: "donatedAt",
        accessorKey: "donatedAt",
        header: () => t("columns.date"),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.donatedAt, locale, "short")}
          </span>
        ),
      },
      {
        id: "donor",
        header: () => t("columns.donor"),
        cell: ({ row }) => {
          const name = donationDonorName(row.original) ?? t("anonymousDonor");
          return (
            <Link
              href={`/constituents/${row.original.constituentId}`}
              onClick={(event) => event.stopPropagation()}
              className="font-medium text-on-surface hover:text-primary hover:underline"
            >
              {name}
            </Link>
          );
        },
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
      {
        id: "campaign",
        header: () => t("columns.campaign"),
        cell: ({ row }) =>
          row.original.campaignId ? (
            <span className="truncate text-on-surface-variant">{row.original.campaignId}</span>
          ) : (
            <span className="text-on-surface-variant opacity-60">—</span>
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
        id: "receipt",
        header: () => t("columns.receipt"),
        cell: ({ row }) => {
          const status = row.original.receiptStatus;
          if (!status) {
            return <span className="text-on-surface-variant opacity-60">—</span>;
          }
          return <Badge variant={RECEIPT_VARIANTS[status]}>{t(`receiptStatus.${status}`)}</Badge>;
        },
      },
    ],
    [t, locale],
  );

  return (
    <div className="transition-opacity duration-normal">
      <DataTable
        columns={columns}
        data={donations}
        pagination={pagination}
        onPageChange={navigateToPage}
        onRowClick={(row) => router.push(`/donations/${row.original.id}`)}
        emptyState={
          <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.description")} />
        }
      />
    </div>
  );
}
