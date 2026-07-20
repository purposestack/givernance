"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Gift, MoreHorizontal, Pencil, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  type DonationListRow,
  type DonationSortField,
  type DonationSortOrder,
  donationDonorName,
  type ReceiptStatus,
} from "@/models/donation";
import { DonationService } from "@/services/DonationService";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const RECEIPT_VARIANTS: Record<ReceiptStatus, BadgeVariant> = {
  generated: "success",
  pending: "warning",
  failed: "error",
};

interface DonationsTableProps {
  donations: DonationListRow[];
  pagination: DataTablePagination;
  canWrite: boolean;
  canDelete: boolean;
  /**
   * Server-resolved sort field from `searchParams` (validated against the
   * `DONATION_SORT_FIELDS` whitelist on the page). Mirrors the
   * tenants-table (admin) pattern: the table renders the indicator from
   * this prop and pushes new query params on click — sorting always
   * round-trips through the API, never via TanStack's local sort.
   */
  sort: DonationSortField;
  order: DonationSortOrder;
}

export function DonationsTable({
  donations,
  pagination,
  canWrite,
  canDelete,
  sort,
  order,
}: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("donations");
  const tReceipt = useTranslations("donations.receiptStatus");
  const tFilters = useTranslations("donations.filters");
  const [donationToDelete, setDonationToDelete] = useState<DonationListRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const initialSearch = searchParams.get("search") ?? "";
  const initialReceipt = searchParams.get("receiptStatus") ?? "all";
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  // Issue #216: surface a pending state on the table during URL-driven
  // round-trips. `isPending` flips true while the server resolves the
  // new sort/filter/page slice and flips back when the new RSC payload
  // commits. Wiring router.push/replace inside `startTransition` is the
  // canonical Next.js App Router pattern for this.
  const [isPending, startTransition] = useTransition();

  // Server-side search: see campaigns-table.tsx for the rationale on why
  // `searchParams` is excluded from the deps.
  // Issue #217: search/filter/sort changes use `router.replace` instead
  // of `push` — back button should escape the page, not unwind every
  // header click. Pagination still uses `push` (meaningful navigation
  // users may want to retrace).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (searchTerm === initialSearch) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (searchTerm) {
        params.set("search", searchTerm);
      } else {
        params.delete("search");
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const updateReceipt = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next && next !== "all") {
        params.set("receiptStatus", next);
      } else {
        params.delete("receiptStatus");
      }
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

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

  // Drive the DataTable's sort indicator from the server-resolved `sort` /
  // `order` URL params, not from local TanStack state. Without this, click
  // → URL update → re-render would briefly show the OLD direction's arrow
  // (DataTable's internal state lags the server round-trip by one paint).
  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [order, sort],
  );

  // Header click handler. Replaces (not pushes) the URL with the new
  // `?sort=&order=` and resets the page back to 1 — paginating into a
  // sorted slice is meaningless when the slice itself just shifted.
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
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [pathname, router, searchParams],
  );

  const confirmDelete = useCallback(async () => {
    if (!donationToDelete) {
      return;
    }

    setIsDeleting(true);
    try {
      await DonationService.deleteDonation(createClientApiClient(), donationToDelete.id);
      toast.success(t("success.deleted"));
      setDonationToDelete(null);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof ApiProblem
          ? (error.detail ?? error.title ?? t("errors.deleteGeneric"))
          : t("errors.deleteGeneric");
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }, [donationToDelete, router, t]);

  const columns = useMemo<ColumnDef<DonationListRow>[]>(
    () => [
      // Column `id` matches the API's `sort=` value (cf.
      // `DONATION_SORT_FIELDS` in the route). Every server-sortable
      // column needs an `accessorKey` or `accessorFn` even in manual-
      // sort mode — TanStack's `getCanSort()` returns false (and skips
      // the header arrow) when a column has no accessor, regardless of
      // `enableSorting`. The accessor's extracted value is unused on
      // the server-sort path; only the column's `id` reaches the API.
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
        accessorFn: (row) => donationDonorName(row) ?? "",
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
        id: "amountCents",
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
        accessorFn: (row) => row.campaign?.name ?? "",
        header: () => t("columns.campaign"),
        cell: ({ row }) =>
          row.original.campaign ? (
            <span className="truncate text-on-surface-variant">{row.original.campaign.name}</span>
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
        enableSorting: false,
        cell: ({ row }) => {
          const status = row.original.receiptStatus;
          if (!status) {
            return <span className="text-on-surface-variant opacity-60">—</span>;
          }
          return <Badge variant={RECEIPT_VARIANTS[status]}>{t(`receiptStatus.${status}`)}</Badge>;
        },
      },
      // Drop the actions column entirely when no row action is available,
      // so we don't render an `sr-only` "Actions" header above empty cells.
      // Mirrors the constituents-table pattern from PR #170.
      ...(canWrite || canDelete
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: DonationListRow } }) => (
                <DonationActions
                  donation={row.original}
                  canEdit={canWrite}
                  canDelete={canDelete}
                  onDelete={() => setDonationToDelete(row.original)}
                  menuLabel={t("actions.menu", {
                    name: donationDonorName(row.original) ?? t("anonymousDonor"),
                  })}
                  editLabel={t("actions.edit")}
                  deleteLabel={t("actions.delete")}
                />
              ),
            } satisfies ColumnDef<DonationListRow>,
          ]
        : []),
    ],
    [canDelete, canWrite, locale, t],
  );

  return (
    <>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant opacity-50"
            size={16}
          />
          <Input
            placeholder={tFilters("searchPlaceholder")}
            aria-label={tFilters("searchPlaceholder")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={initialReceipt} onValueChange={updateReceipt}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={tFilters("receiptLabel")}>
            <SelectValue placeholder={tFilters("receiptLabel")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tFilters("allReceipts")}</SelectItem>
            <SelectItem value="generated">{tReceipt("generated")}</SelectItem>
            <SelectItem value="pending">{tReceipt("pending")}</SelectItem>
            <SelectItem value="failed">{tReceipt("failed")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={donations}
        pagination={pagination}
        onPageChange={navigateToPage}
        sorting={sorting}
        onSortingChange={onSortingChange}
        isPending={isPending}
        // ADR-035 rules A2/A3 — the table container is slot 0 of the
        // content cascade (container before content), rows follow from
        // slot 1. The DataTable gates the replay on the mount-time data +
        // sorting references (rule B12), so search keystrokes / filter /
        // sort / pagination stay instant.
        className="reveal-item"
        animateEntrance
        entranceCascadeOffset={1}
        onRowClick={(row) => router.push(`/donations/${row.original.id}`)}
        emptyState={
          <EmptyState icon={Gift} title={t("empty.title")} description={t("empty.description")} />
        }
      />

      <AlertDialog
        open={donationToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDonationToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {donationToDelete
                ? t("deleteDialog.description", {
                    name: donationDonorName(donationToDelete) ?? t("anonymousDonor"),
                  })
                : t("deleteDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isDeleting}>
                {t("deleteDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? t("deleteDialog.deleting") : t("deleteDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface DonationActionsProps {
  donation: DonationListRow;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
}

function DonationActions({
  donation,
  canEdit,
  canDelete,
  onDelete,
  menuLabel,
  editLabel,
  deleteLabel,
}: DonationActionsProps) {
  if (!canEdit && !canDelete) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={menuLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {canEdit ? (
          <DropdownMenuItem asChild>
            <Link
              href={`/donations/${donation.id}/edit`}
              onClick={(event) => event.stopPropagation()}
            >
              <Pencil size={16} aria-hidden="true" />
              {editLabel}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canDelete ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDelete();
            }}
            className="text-error focus:text-error"
          >
            <Trash2 size={16} aria-hidden="true" />
            {deleteLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
