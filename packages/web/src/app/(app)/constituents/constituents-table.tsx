"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Search, Trash2, Users } from "lucide-react";
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
import { DataTable } from "@/components/ui/data-table";
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
import { formatDate } from "@/lib/format";
import {
  type ConstituentListRow,
  type ConstituentSortField,
  type ConstituentSortOrder,
  fullName,
  initials,
} from "@/models/constituent";
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
  constituents: ConstituentListRow[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
  /**
   * Delete is `requireOrgAdmin` server-side; when `false`, the row's
   * dropdown only shows Edit. Mirrors the donations + members table
   * shortcut pattern.
   */
  canManageAdminActions: boolean;
  /**
   * `false` for the `viewer` role — Edit is gated to write-capable roles
   * server-side (`PUT /v1/constituents/:id` is `requireWrite`), so we hide
   * the row dropdown entirely when no action is available.
   */
  canWrite: boolean;
  /** Server-resolved sort/order — see donations-table.tsx for rationale. */
  sort: ConstituentSortField;
  order: ConstituentSortOrder;
}

export function ConstituentsTable({
  constituents,
  pagination,
  canManageAdminActions,
  canWrite,
  sort,
  order,
}: ConstituentsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("constituents");
  const tType = useTranslations("constituents.types");
  const locale = useLocale();
  const tFilters = useTranslations("constituents.filters");
  const [deleteTarget, setDeleteTarget] = useState<ConstituentListRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const initialSearch = searchParams.get("search") ?? "";
  const initialType = searchParams.get("type") ?? "all";
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  // Issue #216: see donations-table.tsx for the pattern.
  const [isPending, startTransition] = useTransition();

  // Server-side search: see campaigns-table.tsx for the rationale on why
  // `searchParams` is excluded from the deps.
  // Issue #217: search/filter/sort use `router.replace`; pagination uses
  // `router.push` so prev/next remain meaningful navigation steps.
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

  const updateType = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next && next !== "all") {
        params.set("type", next);
      } else {
        params.delete("type");
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

  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: order === "desc" }],
    [order, sort],
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
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
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

  const columns = useMemo<ColumnDef<ConstituentListRow>[]>(
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
        cell: ({ row }) => (
          <span className="text-on-surface-variant">{row.original.email ?? "—"}</span>
        ),
      },
      {
        id: "tags",
        accessorKey: "tags",
        header: () => t("columns.tags"),
        enableSorting: false,
        cell: ({ row }) => {
          const tags = row.original.tags;
          if (!tags || tags.length === 0) {
            return <span className="text-on-surface-variant">—</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="neutral" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: "lastDonation",
        accessorFn: (row) => row.lastDonationAt ?? "",
        header: () => t("columns.lastDonation"),
        cell: ({ row }) =>
          row.original.lastDonationAt ? (
            <span className="whitespace-nowrap text-on-surface-variant">
              {formatDate(row.original.lastDonationAt, locale, "short")}
            </span>
          ) : (
            <span className="text-on-surface-variant opacity-60">—</span>
          ),
      },
      // For viewers (no Edit, no Delete) we drop the column entirely — keeping
      // it would render an `sr-only` "Actions" header above empty cells, a
      // small a11y nuisance and a wasted column on info-dense screens.
      ...(canWrite || canManageAdminActions
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: ConstituentListRow } }) => (
                <ConstituentRowActions
                  constituent={row.original}
                  canEdit={canWrite}
                  canDelete={canManageAdminActions}
                  onDelete={() => setDeleteTarget(row.original)}
                  menuLabel={t("actions.menu", { name: fullName(row.original) })}
                  editLabel={t("actions.edit")}
                  deleteLabel={t("actions.delete")}
                />
              ),
            } satisfies ColumnDef<ConstituentListRow>,
          ]
        : []),
    ],
    [canManageAdminActions, canWrite, locale, t, tType],
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
        <Select value={initialType} onValueChange={updateType}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={tFilters("typeLabel")}>
            <SelectValue placeholder={tFilters("allTypes")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tFilters("allTypes")}</SelectItem>
            <SelectItem value="donor">{tType("donor")}</SelectItem>
            <SelectItem value="volunteer">{tType("volunteer")}</SelectItem>
            <SelectItem value="member">{tType("member")}</SelectItem>
            <SelectItem value="beneficiary">{tType("beneficiary")}</SelectItem>
            <SelectItem value="partner">{tType("partner")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={constituents}
        pagination={pagination}
        onPageChange={navigateToPage}
        sorting={sorting}
        onSortingChange={onSortingChange}
        isPending={isPending}
        onRowClick={(row) => router.push(`/constituents/${row.original.id}`)}
        emptyState={
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.description")} />
        }
      />

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
  constituent: ConstituentListRow;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
}

function ConstituentRowActions({
  constituent,
  canEdit,
  canDelete,
  onDelete,
  menuLabel,
  editLabel,
  deleteLabel,
}: ConstituentRowActionsProps) {
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
              href={`/constituents/${constituent.id}/edit`}
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
