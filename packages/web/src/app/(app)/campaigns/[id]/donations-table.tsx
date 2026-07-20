"use client";

import type { CustomFieldDefinition } from "@givernance/shared/custom-fields";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Gift } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useTransition } from "react";
import { buildCustomFieldColumns } from "@/components/shared/custom-fields";
import { EmptyState } from "@/components/shared/empty-state";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  type DonationListRow,
  type DonationSortField,
  type DonationSortOrder,
  donationDonorName,
} from "@/models/donation";

interface DonationsTableProps {
  donations: DonationListRow[];
  pagination: DataTablePagination;
  /**
   * Server-resolved sort field + order from the URL (`?sort=&order=`).
   * Sorting is done in the DATABASE across the whole list — never client-side
   * over the visible page, which would only reorder the current 25 rows of
   * 155 and (for names) sort accents by code point. Accent collation is
   * handled server-side via `COLLATE "und-x-icu"`.
   */
  sort: DonationSortField;
  order: DonationSortOrder;
  /**
   * Epic #539 §6 — projected (showOnRelated ∧ ¬sensitive) constituent
   * definitions rendered as extra donor columns from `row.donorCustom`.
   * Empty ⇒ no custom columns (flag off / nothing projected).
   */
  donorCustomDefs?: CustomFieldDefinition[];
}

export function DonationsTable({
  donations,
  pagination,
  sort,
  order,
  donorCustomDefs = [],
}: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const t = useTranslations("campaigns.detail.donations");
  const tCustom = useTranslations("customFields");

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
        // `scroll: false` — the table sits at the bottom of a long campaign
        // page; the App Router's default scroll-to-top would yank the user
        // away from the rows they're paging through.
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  // Drive the sort indicator from the server-resolved URL params (not local
  // TanStack state) so the arrow can't lag the RSC round-trip by a paint.
  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [order, sort],
  );

  // Header click → replace the URL with the new `?sort=&order=` and reset to
  // page 1 (paginating into a slice that just shifted is meaningless). The
  // column ids ARE the API sort fields, so `next.id` maps directly.
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
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        // `scroll: false` — keep the viewport on the table (it's near the
        // bottom of the page) instead of jumping to the top on every sort.
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
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
        // `id` matches the API sort field `donor`. The `accessorFn` is what
        // makes TanStack treat this as a sortable column (a pure display
        // column shows no sort toggle); the value itself is unused because
        // `manualSorting` delegates the actual ordering to the DB.
        id: "donor",
        accessorFn: (row) => donationDonorName(row) ?? "",
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
        // The API has no sort field for the payment reference — keep it
        // non-sortable rather than show a toggle that 400s.
        enableSorting: false,
        header: () => t("columns.reference"),
        cell: ({ row }) => (
          <span className="text-on-surface-variant">
            {row.original.paymentRef ?? t("noReference")}
          </span>
        ),
      },
      // Epic #539 §6 — donor projection columns (flag-gated: empty defs ⇒
      // spread nothing, table byte-for-byte like today).
      ...buildCustomFieldColumns<DonationListRow>(donorCustomDefs, {
        locale,
        getValues: (row) => row.donorCustom,
        idPrefix: "donorCustom",
        booleanLabels: { yes: tCustom("boolean.yes"), no: tCustom("boolean.no") },
      }),
      {
        // `id` matches the API sort field `amountCents`.
        id: "amountCents",
        accessorKey: "amountCents",
        header: () => <span className="block text-right">{t("columns.amount")}</span>,
        cell: ({ row }) => (
          <span className="block text-right font-mono font-semibold tabular-nums text-on-surface">
            {formatCurrency(row.original.amountCents, locale, row.original.currency)}
          </span>
        ),
      },
    ],
    [donorCustomDefs, locale, t, tCustom],
  );

  return (
    <div
      className={cn("transition-opacity duration-normal", isPending ? "opacity-60" : "opacity-100")}
      aria-busy={isPending || undefined}
    >
      <DataTable
        columns={columns}
        data={donations}
        sorting={sorting}
        onSortingChange={onSortingChange}
        pagination={pagination}
        onPageChange={navigateToPage}
        onRowClick={(row) => router.push(`/donations/${row.original.id}`)}
        emptyState={<EmptyState icon={Gift} title={t("title")} description={t("empty")} />}
      />
    </div>
  );
}
