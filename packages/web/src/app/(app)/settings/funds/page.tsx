import { PiggyBank, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { FundService } from "@/services/FundService";

import { FundsTable } from "./funds-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

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

  const client = await createServerApiClient();
  const result = await FundService.listFunds(client, { page, perPage });

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
        <FundsTable funds={result.data} pagination={result.pagination} />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest shadow-card">
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
