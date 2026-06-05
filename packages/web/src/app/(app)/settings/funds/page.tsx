import { PiggyBank, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { FundSortField, FundSortOrder } from "@/models/fund";
import { FundService } from "@/services/FundService";

import { FundsTable } from "./funds-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
/**
 * Mirror of `FUND_SORT_FIELDS` from the API
 * (`packages/api/src/modules/funds/routes.ts`).
 */
const FUND_SORT_FIELDS = new Set<FundSortField>(["name", "type", "createdAt"]);
const DEFAULT_SORT: FundSortField = "createdAt";
const DEFAULT_ORDER: FundSortOrder = "desc";

function parseSortField(value: string | string[] | undefined): FundSortField {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && FUND_SORT_FIELDS.has(raw as FundSortField) ? (raw as FundSortField) : DEFAULT_SORT;
}

function parseSortOrder(value: string | string[] | undefined): FundSortOrder {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" ? "asc" : DEFAULT_ORDER;
}

interface FundsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export default async function FundsPage({ searchParams }: FundsPageProps) {
  const auth = await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("settings.funds");
  const tSettings = await getTranslations("settings");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const canManageFunds = auth.roles.includes("org_admin");
  const sort = parseSortField(params.sort);
  const order = parseSortOrder(params.order);

  const client = await createServerApiClient();
  const result = await FundService.listFunds(client, { page, perPage, sort, order });

  const hasAny = result.pagination.total > 0;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={
          hasAny ? t("subtitleWithCount", { count: result.pagination.total }) : t("subtitleEmpty")
        }
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: t("settings"), href: "/settings" },
          { label: t("title") },
        ]}
        actions={
          canManageFunds ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/settings/funds/new">
                <Plus size={16} aria-hidden="true" />
                {t("actions.new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <SettingsNavigation />

      {hasAny ? (
        <FundsTable
          funds={result.data}
          pagination={result.pagination}
          canManageFunds={canManageFunds}
          sort={sort}
          order={order}
        />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest border border-border-brand">
          <EmptyState
            icon={PiggyBank}
            title={t("empty.title")}
            description={t("empty.description")}
          />
        </div>
      )}
    </>
  );
}
