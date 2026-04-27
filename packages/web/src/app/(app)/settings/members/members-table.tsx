"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, RefreshCw, Trash2, Users } from "lucide-react";
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
import type { Invitation, InvitationStatus } from "@/models/invitation";
import { InvitationService } from "@/services/InvitationService";

interface MembersTableProps {
  invitations: Invitation[];
  pagination: DataTablePagination;
  canManageMembers: boolean;
}

const STATUS_VARIANT: Record<InvitationStatus, "success" | "info" | "warning"> = {
  accepted: "success",
  pending: "info",
  expired: "warning",
};

export function MembersTable({ invitations, pagination, canManageMembers }: MembersTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("settings.members");
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  const navigateToPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (page <= 1) params.delete("page");
      else params.set("page", String(page));
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const onResend = useCallback(
    async (invitation: Invitation) => {
      setIsMutating(true);
      try {
        await InvitationService.resendInvitation(createClientApiClient(), invitation.id);
        toast.success(t("success.resent"));
        router.refresh();
      } catch (err) {
        if (!(err instanceof ApiProblem)) console.error("members.resend failed", err);
        const message =
          err instanceof ApiProblem
            ? (err.detail ?? err.title ?? t("errors.resendGeneric"))
            : t("errors.resendGeneric");
        toast.error(message);
      } finally {
        setIsMutating(false);
      }
    },
    [router, t],
  );

  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setIsMutating(true);
    try {
      await InvitationService.revokeInvitation(createClientApiClient(), revokeTarget.id);
      toast.success(t("success.revoked"));
      setRevokeTarget(null);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("members.revoke failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.revokeGeneric"))
          : t("errors.revokeGeneric");
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  }, [revokeTarget, router, t]);

  const columns = useMemo<ColumnDef<Invitation>[]>(
    () => [
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium text-on-surface">{row.original.email}</span>
        ),
      },
      {
        id: "role",
        accessorKey: "role",
        header: () => t("columns.role"),
        enableSorting: false,
        cell: ({ row }) => <Badge variant="neutral">{t(`roles.${row.original.role}`)}</Badge>,
      },
      {
        id: "status",
        accessorKey: "status",
        header: () => t("columns.status"),
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={STATUS_VARIANT[row.original.status]}>
            {t(`statuses.${row.original.status}`)}
          </Badge>
        ),
      },
      {
        id: "invitedBy",
        accessorKey: "invitedByName",
        header: () => t("columns.invitedBy"),
        enableSorting: false,
        // Hidden on narrow viewports — the table already overflows on mobile
        // and "Invited by" is the lowest-priority column for triage.
        meta: { className: "hidden md:table-cell" },
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {row.original.invitedByName ?? "—"}
          </span>
        ),
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: () => t("columns.createdAt"),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.createdAt, locale, "short")}
          </span>
        ),
      },
      ...(canManageMembers
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: Invitation } }) => {
                const canResend = row.original.status !== "accepted";
                const canRevoke = row.original.status !== "accepted";
                if (!canResend && !canRevoke) return null;
                return (
                  <RowActions
                    onResend={canResend ? () => void onResend(row.original) : undefined}
                    onRevoke={canRevoke ? () => setRevokeTarget(row.original) : undefined}
                    disabled={isMutating}
                    resendLabel={t("actions.resend")}
                    revokeLabel={t("actions.revoke")}
                    menuLabel={t("actions.menu", { email: row.original.email })}
                  />
                );
              },
            } satisfies ColumnDef<Invitation>,
          ]
        : []),
    ],
    [canManageMembers, isMutating, locale, onResend, t],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={invitations}
        pagination={pagination}
        onPageChange={navigateToPage}
        emptyState={
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.description")} />
        }
      />

      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget
                ? t("revokeDialog.description", { email: revokeTarget.email })
                : t("revokeDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isMutating}>
                {t("revokeDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmRevoke()}
              disabled={isMutating}
            >
              {isMutating ? t("revokeDialog.revoking") : t("revokeDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface RowActionsProps {
  onResend: (() => void) | undefined;
  onRevoke: (() => void) | undefined;
  disabled: boolean;
  resendLabel: string;
  revokeLabel: string;
  menuLabel: string;
}

function RowActions({
  onResend,
  onRevoke,
  disabled,
  resendLabel,
  revokeLabel,
  menuLabel,
}: RowActionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={menuLabel}
          className="justify-center"
          disabled={disabled}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onResend ? (
          <DropdownMenuItem onSelect={onResend}>
            <RefreshCw size={16} aria-hidden="true" />
            {resendLabel}
          </DropdownMenuItem>
        ) : null}
        {onRevoke ? (
          <DropdownMenuItem onSelect={onRevoke} className="text-error focus:text-error">
            <Trash2 size={16} aria-hidden="true" />
            {revokeLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
