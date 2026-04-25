"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, RefreshCw, Trash2, UserPlus, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useCallback, useId, useMemo, useState } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { Invitation, InvitationRole, InvitationStatus } from "@/models/invitation";
import { InvitationService } from "@/services/InvitationService";

interface MembersTableProps {
  invitations: Invitation[];
  pagination: DataTablePagination;
  canManageMembers: boolean;
}

const ROLE_VALUES: readonly InvitationRole[] = ["user", "org_admin", "viewer"];

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
  const [inviteOpen, setInviteOpen] = useState(false);
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
                    invitation={row.original}
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
      {canManageMembers ? (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus size={16} aria-hidden="true" />
            {t("actions.invite")}
          </Button>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        data={invitations}
        pagination={pagination}
        onPageChange={navigateToPage}
        emptyState={
          <EmptyState icon={Users} title={t("empty.title")} description={t("empty.description")} />
        }
      />

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revokeDialog.title")}</DialogTitle>
            <DialogDescription>
              {revokeTarget
                ? t("revokeDialog.description", { email: revokeTarget.email })
                : t("revokeDialog.descriptionFallback")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)} disabled={isMutating}>
              {t("revokeDialog.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmRevoke()}
              disabled={isMutating}
            >
              {isMutating ? t("revokeDialog.revoking") : t("revokeDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface RowActionsProps {
  invitation: Invitation;
  onResend: (() => void) | undefined;
  onRevoke: (() => void) | undefined;
  disabled: boolean;
  resendLabel: string;
  revokeLabel: string;
  menuLabel: string;
}

function RowActions({
  invitation: _invitation,
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

// ─── Invite dialog ──────────────────────────────────────────────────────────

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const router = useRouter();
  const t = useTranslations("settings.members");
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitationRole>("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setEmail("");
    setRole("user");
    setError(null);
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) reset();
    },
    [onOpenChange, reset],
  );

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = email.trim();
      if (trimmed.length === 0) {
        setError(t("invite.errors.emailRequired"));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await InvitationService.createInvitation(createClientApiClient(), {
          email: trimmed,
          role,
        });
        toast.success(t("success.invited", { email: trimmed }));
        handleClose(false);
        router.refresh();
      } catch (err) {
        if (!(err instanceof ApiProblem)) console.error("members.invite failed", err);
        if (err instanceof ApiProblem && err.detail) {
          setError(err.detail);
        } else {
          setError(t("invite.errors.generic"));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, handleClose, role, router, t],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("invite.title")}</DialogTitle>
          <DialogDescription>{t("invite.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error ? (
            <div
              role="alert"
              aria-live="polite"
              className="rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
            >
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={emailId} required>
              {t("invite.fields.email")}
            </Label>
            <Input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              maxLength={255}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("invite.fields.emailPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={roleId} required>
              {t("invite.fields.role")}
            </Label>
            <Select value={role} onValueChange={(v) => setRole(v as InvitationRole)}>
              <SelectTrigger id={roleId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_VALUES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">{t(`invite.roleHints.${role}`)}</p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>
              {t("invite.actions.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("invite.actions.submitting") : t("invite.actions.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
