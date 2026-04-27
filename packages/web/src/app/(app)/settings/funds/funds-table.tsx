"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, PiggyBank, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatDate } from "@/lib/format";
import type { Fund, FundType } from "@/models/fund";
import { FundService } from "@/services/FundService";

const FUND_TYPES = new Set<FundType>(["restricted", "unrestricted"]);

const TYPE_VARIANTS: Record<FundType, "warning" | "info"> = {
  restricted: "warning",
  unrestricted: "info",
};

interface FundsTableProps {
  funds: Fund[];
  pagination: DataTablePagination;
  canManageFunds: boolean;
}

function isFundType(value: string): value is FundType {
  return FUND_TYPES.has(value as FundType);
}

export function FundsTable({ funds, pagination, canManageFunds }: FundsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("settings.funds");
  const [fundToDelete, setFundToDelete] = useState<Fund | null>(null);
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
    if (!fundToDelete) return;

    setIsDeleting(true);
    try {
      await FundService.deleteFund(createClientApiClient(), fundToDelete.id);
      toast.success(t("success.deleted"));
      setFundToDelete(null);
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
  }, [fundToDelete, router, t]);

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
      ...(canManageFunds
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: Fund } }) => (
                <FundActions
                  fund={row.original}
                  onDelete={() => setFundToDelete(row.original)}
                  editLabel={t("actions.edit")}
                  deleteLabel={t("actions.delete")}
                  menuLabel={t("actions.menu", { name: row.original.name })}
                />
              ),
            } satisfies ColumnDef<Fund>,
          ]
        : []),
    ],
    [canManageFunds, locale, t],
  );

  return (
    <>
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
      <AlertDialog open={fundToDelete !== null} onOpenChange={(open) => !open && setFundToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {fundToDelete
                ? t("deleteDialog.description", { name: fundToDelete.name })
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
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? t("deleteDialog.deleting") : t("deleteDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface FundActionsProps {
  fund: Fund;
  onDelete: () => void;
  editLabel: string;
  deleteLabel: string;
  menuLabel: string;
}

function FundActions({ fund, onDelete, editLabel, deleteLabel, menuLabel }: FundActionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={menuLabel} className="justify-center">
          <MoreHorizontal size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/settings/funds/${fund.id}/edit`}>
            <Pencil size={16} aria-hidden="true" />
            {editLabel}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDelete} className="text-error focus:text-error">
          <Trash2 size={16} aria-hidden="true" />
          {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
