"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Gift, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";

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
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency, formatDate } from "@/lib/format";
import { type DonationListRow, donationDonorName, type ReceiptStatus } from "@/models/donation";
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
}

export function DonationsTable({
  donations,
  pagination,
  canWrite,
  canDelete,
}: DonationsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("donations");
  const [donationToDelete, setDonationToDelete] = useState<DonationListRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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
      // Drop the actions column entirely for viewers (no Edit, no Delete) so
      // we don't render an `sr-only` "Actions" header above empty cells.
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
