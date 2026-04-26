"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { type Constituent, fullName, initials } from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const TYPE_VARIANTS: Record<string, BadgeVariant> = {
  donor: "success",
  volunteer: "info",
  member: "warning",
  beneficiary: "warning",
  partner: "neutral",
};

const KNOWN_TYPES = new Set(["donor", "volunteer", "member", "beneficiary", "partner"]);

function translateType(
  tType: (key: "donor" | "volunteer" | "member" | "beneficiary" | "partner") => string,
  type: string,
): string {
  if (KNOWN_TYPES.has(type)) {
    return tType(type as "donor" | "volunteer" | "member" | "beneficiary" | "partner");
  }
  return type;
}

interface ConstituentsTableProps {
  constituents: Constituent[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
  /**
   * Delete is `requireOrgAdmin` server-side; when `false`, the row's
   * dropdown only shows Edit. Mirrors the donations + members table
   * shortcut pattern.
   */
  canManageAdminActions: boolean;
}

export function ConstituentsTable({
  constituents,
  pagination,
  canManageAdminActions,
}: ConstituentsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("constituents");
  const tType = useTranslations("constituents.types");
  const [deleteTarget, setDeleteTarget] = useState<Constituent | null>(null);
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
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await ConstituentService.deleteConstituent(createClientApiClient(), deleteTarget.id);
      toast.success(t("success.deleted"));
      setDeleteTarget(null);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("constituents.delete failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.deleteGeneric"))
          : t("errors.deleteGeneric");
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, router, t]);

  const columns = useMemo<ColumnDef<Constituent>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => fullName(row),
        header: () => t("columns.name"),
        enableSorting: true,
        cell: ({ row }) => {
          const constituent = row.original;
          return (
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
              >
                {initials(constituent)}
              </span>
              <span className="font-medium text-on-surface">{fullName(constituent)}</span>
            </div>
          );
        },
      },
      {
        id: "type",
        accessorKey: "type",
        header: () => t("columns.type"),
        enableSorting: true,
        cell: ({ row }) => {
          const type = String(row.original.type);
          const variant = TYPE_VARIANTS[type] ?? "neutral";
          const label = translateType(tType, type);
          return <Badge variant={variant}>{label}</Badge>;
        },
      },
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.email ?? "—"}</span>
        ),
      },
      {
        id: "lastDonation",
        header: () => t("columns.lastDonation"),
        enableSorting: false,
        cell: () => <span className="text-on-surface-variant">—</span>,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("columns.actions")}</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <ConstituentRowActions
            constituent={row.original}
            canDelete={canManageAdminActions}
            onDelete={() => setDeleteTarget(row.original)}
            menuLabel={t("actions.menu", { name: fullName(row.original) })}
            editLabel={t("actions.edit")}
            deleteLabel={t("actions.delete")}
          />
        ),
      },
    ],
    [canManageAdminActions, t, tType],
  );

  return (
    <>
      <div className="transition-opacity duration-normal">
        <DataTable
          columns={columns}
          data={constituents}
          pagination={pagination}
          onPageChange={navigateToPage}
          onRowClick={(row) => router.push(`/constituents/${row.original.id}`)}
          emptyState={
            <EmptyState
              icon={Users}
              title={t("empty.title")}
              description={t("empty.description")}
            />
          }
        />
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("deleteDialog.description", { name: fullName(deleteTarget) })
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

interface ConstituentRowActionsProps {
  constituent: Constituent;
  canDelete: boolean;
  onDelete: () => void;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
}

function ConstituentRowActions({
  constituent,
  canDelete,
  onDelete,
  menuLabel,
  editLabel,
  deleteLabel,
}: ConstituentRowActionsProps) {
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
        <DropdownMenuItem asChild>
          <Link
            href={`/constituents/${constituent.id}/edit`}
            onClick={(event) => event.stopPropagation()}
          >
            <Pencil size={16} aria-hidden="true" />
            {editLabel}
          </Link>
        </DropdownMenuItem>
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
