"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useCallback, useId, useMemo, useState } from "react";

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
import type { Member, MemberRole } from "@/models/member";
import { MemberService } from "@/services/MemberService";

const ROLE_VALUES: readonly MemberRole[] = ["user", "org_admin", "viewer"];

interface MembersTableProps {
  members: Member[];
  canManageMembers: boolean;
  /**
   * Keycloak `sub` of the caller — used to identify the caller's own row so
   * the role Select can be locked (the API still enforces the
   * `cannot_self_demote` 422; the UI lock is polish).
   */
  currentUserKeycloakId: string;
}

/**
 * Members table — accepted teammates on the current tenant. Lists
 * `users` rows from `GET /v1/users` and offers an Edit affordance per
 * row that opens the same-shape dialog as the invite form (firstName /
 * lastName / role). The role Select on the caller's own row is hidden
 * with a tooltip explaining "you can't change your own role" (issue
 * #161 — the API gate is the durable enforcement).
 */
export function MembersTable({
  members,
  canManageMembers,
  currentUserKeycloakId,
}: MembersTableProps) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("settings.members");
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  const confirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    setIsMutating(true);
    try {
      await MemberService.removeMember(createClientApiClient(), removeTarget.id);
      toast.success(t("success.memberRemoved"));
      setRemoveTarget(null);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("members.remove failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.removeGeneric"))
          : t("errors.removeGeneric");
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  }, [removeTarget, router, t]);

  const columns = useMemo<ColumnDef<Member>[]>(() => {
    const base: ColumnDef<Member>[] = [
      {
        id: "name",
        header: () => t("columns.name"),
        enableSorting: false,
        cell: ({ row }) => {
          const isSelf = row.original.keycloakId === currentUserKeycloakId;
          const fullName = `${row.original.firstName} ${row.original.lastName}`.trim();
          return (
            <div className="flex items-center gap-2">
              <span className="font-medium text-on-surface">{fullName || "—"}</span>
              {isSelf ? (
                <Badge variant="neutral" className="text-[0.625rem] uppercase">
                  {t("editDialog.fields.youBadge")}
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "email",
        accessorKey: "email",
        header: () => t("columns.email"),
        enableSorting: false,
        cell: ({ row }) => <span className="text-on-surface-variant">{row.original.email}</span>,
      },
      {
        id: "role",
        accessorKey: "role",
        header: () => t("columns.role"),
        enableSorting: false,
        cell: ({ row }) => <Badge variant="neutral">{t(`roles.${row.original.role}`)}</Badge>,
      },
      {
        id: "joinedAt",
        accessorKey: "createdAt",
        header: () => t("columns.joinedAt"),
        enableSorting: false,
        meta: { className: "hidden md:table-cell" },
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.createdAt, locale, "short")}
          </span>
        ),
      },
    ];

    if (!canManageMembers) return base;

    base.push({
      id: "actions",
      header: () => <span className="sr-only">{t("columns.actions")}</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <RowActions
          onEdit={() => setEditTarget(row.original)}
          onRemove={() => setRemoveTarget(row.original)}
          disabled={isMutating}
          editLabel={t("actions.edit")}
          removeLabel={t("actions.remove")}
          menuLabel={t("actions.menu", { email: row.original.email })}
        />
      ),
    });
    return base;
  }, [canManageMembers, currentUserKeycloakId, isMutating, locale, t]);

  return (
    <>
      <DataTable
        columns={columns}
        data={members}
        emptyState={
          <EmptyState
            icon={Users}
            title={t("membersSection.empty.title")}
            description={t("membersSection.empty.description")}
          />
        }
      />

      {editTarget ? (
        <EditMemberDialog
          target={editTarget}
          isSelf={editTarget.keycloakId === currentUserKeycloakId}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            router.refresh();
          }}
        />
      ) : null}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? t("removeDialog.description", { email: removeTarget.email })
                : t("removeDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isMutating}>
                {t("removeDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmRemove()}
              disabled={isMutating}
            >
              {isMutating ? t("removeDialog.removing") : t("removeDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface RowActionsProps {
  onEdit: () => void;
  onRemove: () => void;
  disabled: boolean;
  editLabel: string;
  removeLabel: string;
  menuLabel: string;
}

function RowActions({
  onEdit,
  onRemove,
  disabled,
  editLabel,
  removeLabel,
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
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil size={16} aria-hidden="true" />
          {editLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRemove} className="text-error focus:text-error">
          <Trash2 size={16} aria-hidden="true" />
          {removeLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Edit dialog ────────────────────────────────────────────────────────────

interface EditMemberDialogProps {
  target: Member;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Controlled edit dialog — same field shape as the invite dialog so the two
 * codepaths stay visually aligned. Submits a partial PATCH carrying only
 * fields that actually changed; an unchanged form returns a "no changes"
 * inline error rather than a no-op API call.
 *
 * Self-edit lock: when `isSelf`, the role Select is hidden (the API still
 * enforces `cannot_self_demote` as the durable gate). The 422 from the
 * server maps to a targeted `selfDemote` error code so the message is
 * actionable rather than a generic toast.
 */
function EditMemberDialog({ target, isSelf, onClose, onSaved }: EditMemberDialogProps) {
  const t = useTranslations("settings.members");
  const firstNameId = useId();
  const lastNameId = useId();
  const roleId = useId();
  const [firstName, setFirstName] = useState(target.firstName);
  const [lastName, setLastName] = useState(target.lastName);
  const [role, setRole] = useState<MemberRole>(target.role);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmedFirst = firstName.trim();
      const trimmedLast = lastName.trim();

      const patch: { firstName?: string; lastName?: string; role?: MemberRole } = {};
      if (trimmedFirst !== target.firstName) patch.firstName = trimmedFirst;
      if (trimmedLast !== target.lastName) patch.lastName = trimmedLast;
      if (!isSelf && role !== target.role) patch.role = role;

      if (Object.keys(patch).length === 0) {
        setError(t("editDialog.errors.noChanges"));
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await MemberService.updateMember(createClientApiClient(), target.id, patch);
        toast.success(t("success.memberUpdated"));
        onSaved();
      } catch (err) {
        if (!(err instanceof ApiProblem)) console.error("members.update failed", err);
        // Server emits `code: cannot_self_demote` as an RFC 9457 extension
        // member on the 422 path so we can render a targeted message rather
        // than rely on string-matching the human-readable `detail`.
        const code =
          err instanceof ApiProblem && typeof err.extensions.code === "string"
            ? err.extensions.code
            : undefined;
        if (code === "cannot_self_demote") {
          setError(t("editDialog.errors.selfDemote"));
        } else if (err instanceof ApiProblem && err.detail) {
          setError(err.detail);
        } else {
          setError(t("editDialog.errors.generic"));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      firstName,
      isSelf,
      lastName,
      onSaved,
      role,
      t,
      target.firstName,
      target.id,
      target.lastName,
      target.role,
    ],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("editDialog.description", { email: target.email })}
          </DialogDescription>
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
            <Label htmlFor={firstNameId}>{t("editDialog.fields.firstName")}</Label>
            <Input
              id={firstNameId}
              autoComplete="given-name"
              maxLength={255}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={lastNameId}>{t("editDialog.fields.lastName")}</Label>
            <Input
              id={lastNameId}
              autoComplete="family-name"
              maxLength={255}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>

          {/*
           * Self-edit lock: hide the role Select on the caller's own row.
           * The API enforces `cannot_self_demote` as the durable gate; this
           * is polish so the admin doesn't accidentally pick "user" and
           * get a 422 toast.
           */}
          {isSelf ? (
            <p className="rounded-lg border border-outline-variant bg-surface-container p-3 text-sm text-on-surface-variant">
              {t("editDialog.fields.selfRoleLockHint")}
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={roleId}>{t("editDialog.fields.role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
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
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              {t("editDialog.actions.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("editDialog.actions.submitting") : t("editDialog.actions.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
