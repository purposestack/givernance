"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Megaphone } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTablePagination } from "@/components/ui/data-table";
import { formatCurrency, formatDate } from "@/lib/format";
import type { Campaign, CampaignStats, CampaignStatus, CampaignType } from "@/models/campaign";

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
}

function isCampaignType(value: string): value is CampaignType {
  return CAMPAIGN_TYPES.has(value as CampaignType);
}

function isCampaignStatus(value: string): value is CampaignStatus {
  return CAMPAIGN_STATUSES.has(value as CampaignStatus);
}

export function CampaignsTable({ campaigns, pagination }: CampaignsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("campaigns");

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
          const goalCents = campaign.costCents ?? 0;
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
    ],
    [t, locale],
  );

  return (
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
  );
}
