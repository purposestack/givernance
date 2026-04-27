"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Megaphone, MoreHorizontal, Pencil, XCircle } from "lucide-react";
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
import type { Campaign, CampaignStats, CampaignStatus, CampaignType } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

interface CampaignWithStats {
  campaign: Campaign;
  stats: CampaignStats | null;
}

const STATUS_VARIANTS: Record<CampaignStatus, BadgeVariant> = {
  draft: "neutral",
  active: "success",
  closed: "info",
};

const TYPE_VARIANTS: Record<CampaignType, BadgeVariant> = {
  nominative_postal: "info",
  door_drop: "warning",
  digital: "success",
};

const CAMPAIGN_TYPES = new Set<CampaignType>(["nominative_postal", "door_drop", "digital"]);
const CAMPAIGN_STATUSES = new Set<CampaignStatus>(["draft", "active", "closed"]);

interface CampaignsTableProps {
  campaigns: CampaignWithStats[];
  pagination: DataTablePagination;
  /**
   * Viewer cannot Edit — `/campaigns/[id]/edit` is `requirePermission("write")`
   * and would 404. Hide the row's Edit affordance to avoid a dead-end.
   */
  canWrite: boolean;
  /**
   * `Close` is `requireOrgAdmin` server-side; when `false`, the row's
   * dropdown only shows Edit. Mirrors the donations + members + constituents
   * shortcut pattern.
   */
  canManageAdminActions: boolean;
}

function isCampaignType(value: string): value is CampaignType {
  return CAMPAIGN_TYPES.has(value as CampaignType);
}

function isCampaignStatus(value: string): value is CampaignStatus {
  return CAMPAIGN_STATUSES.has(value as CampaignStatus);
}

export function CampaignsTable({
  campaigns,
  pagination,
  canWrite,
  canManageAdminActions,
}: CampaignsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("campaigns");
  const [closeTarget, setCloseTarget] = useState<Campaign | null>(null);
  const [isClosing, setIsClosing] = useState(false);

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

  const confirmClose = useCallback(async () => {
    if (!closeTarget) return;
    setIsClosing(true);
    try {
      await CampaignService.closeCampaign(createClientApiClient(), closeTarget.id);
      toast.success(t("success.closed"));
      setCloseTarget(null);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("campaigns.close failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.closeGeneric"))
          : t("errors.closeGeneric");
      toast.error(message);
    } finally {
      setIsClosing(false);
    }
  }, [closeTarget, router, t]);

  const columns = useMemo<ColumnDef<CampaignWithStats>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.campaign.name,
        header: () => t("columns.name"),
        enableSorting: true,
        cell: ({ row }) => {
          const campaign = row.original.campaign;
          return (
            <Link
              href={`/campaigns/${campaign.id}`}
              onClick={(event) => event.stopPropagation()}
              className="font-medium text-on-surface hover:text-primary hover:underline"
            >
              {campaign.name}
            </Link>
          );
        },
      },
      {
        id: "type",
        accessorFn: (row) => row.campaign.type,
        header: () => t("columns.type"),
        enableSorting: true,
        cell: ({ row }) => {
          const type = String(row.original.campaign.type);
          if (!isCampaignType(type)) {
            return <Badge variant="neutral">{type}</Badge>;
          }
          return <Badge variant={TYPE_VARIANTS[type]}>{t(`types.${type}`)}</Badge>;
        },
      },
      {
        id: "status",
        accessorFn: (row) => row.campaign.status,
        header: () => t("columns.status"),
        enableSorting: true,
        cell: ({ row }) => {
          const status = String(row.original.campaign.status);
          if (!isCampaignStatus(status)) {
            return <Badge variant="neutral">{status}</Badge>;
          }
          return <Badge variant={STATUS_VARIANTS[status]}>{t(`status.${status}`)}</Badge>;
        },
      },
      {
        id: "progress",
        header: () => t("columns.progress"),
        enableSorting: false,
        cell: ({ row }) => {
          const { campaign, stats } = row.original;
          const raisedCents = stats?.totalRaisedCents ?? 0;
          const goalCents = campaign.goalAmountCents ?? 0;
          const progress = goalCents > 0 ? Math.min((raisedCents / goalCents) * 100, 100) : 0;

          return (
            <div className="min-w-44">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-mono font-semibold tabular-nums text-on-surface">
                  {formatCurrency(raisedCents, locale)}
                </span>
                <span className="font-mono text-xs tabular-nums text-on-surface-variant">
                  {goalCents > 0 ? formatCurrency(goalCents, locale) : "—"}
                </span>
              </div>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-md bg-surface-container"
                aria-label={t("progressAria", {
                  raised: formatCurrency(raisedCents, locale),
                  goal: goalCents > 0 ? formatCurrency(goalCents, locale) : t("noGoal"),
                })}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <div className="h-full rounded-md bg-primary" style={{ width: `${progress}%` }} />
              </div>
            </div>
          );
        },
      },
      {
        id: "createdAt",
        accessorFn: (row) => row.campaign.createdAt,
        header: () => t("columns.date"),
        enableSorting: true,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-on-surface-variant">
            {formatDate(row.original.campaign.createdAt, locale, "short")}
          </span>
        ),
      },
      // Drop the actions column entirely when no row action is available
      // (viewer with no write access AND no admin actions). Mirrors the
      // donations + constituents tables.
      ...(canWrite || canManageAdminActions
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{t("columns.actions")}</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: CampaignWithStats } }) => {
                const campaign = row.original.campaign;
                const canClose =
                  canManageAdminActions &&
                  (campaign.status === "draft" || campaign.status === "active");
                return (
                  <CampaignRowActions
                    campaign={campaign}
                    canEdit={canWrite}
                    canClose={canClose}
                    onClose={() => setCloseTarget(campaign)}
                    menuLabel={t("actions.menu", { name: campaign.name })}
                    editLabel={t("actions.edit")}
                    closeLabel={t("actions.close")}
                  />
                );
              },
            } satisfies ColumnDef<CampaignWithStats>,
          ]
        : []),
    ],
    [canManageAdminActions, canWrite, t, locale],
  );

  return (
    <>
      <div className="transition-opacity duration-normal">
        <DataTable
          columns={columns}
          data={campaigns}
          pagination={pagination}
          onPageChange={navigateToPage}
          onRowClick={(row) => router.push(`/campaigns/${row.original.campaign.id}`)}
          emptyState={
            <EmptyState
              icon={Megaphone}
              title={t("empty.title")}
              description={t("empty.description")}
            />
          }
        />
      </div>

      <AlertDialog
        open={closeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCloseTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("closeDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {closeTarget
                ? t("closeDialog.description", { name: closeTarget.name })
                : t("closeDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isClosing}>
                {t("closeDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button variant="destructive" disabled={isClosing} onClick={() => void confirmClose()}>
              {isClosing ? t("closeDialog.closing") : t("closeDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface CampaignRowActionsProps {
  campaign: Campaign;
  canEdit: boolean;
  canClose: boolean;
  onClose: () => void;
  menuLabel: string;
  editLabel: string;
  closeLabel: string;
}

function CampaignRowActions({
  campaign,
  canEdit,
  canClose,
  onClose,
  menuLabel,
  editLabel,
  closeLabel,
}: CampaignRowActionsProps) {
  if (!canEdit && !canClose) {
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
              href={`/campaigns/${campaign.id}/edit`}
              onClick={(event) => event.stopPropagation()}
            >
              <Pencil size={16} aria-hidden="true" />
              {editLabel}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canClose ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }}
            className="text-error focus:text-error"
          >
            <XCircle size={16} aria-hidden="true" />
            {closeLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
