import { Banknote, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { isFeatureFlagsPhase2Enabled } from "@/lib/feature-flags/server";
import { BankAccountService } from "@/services/BankAccountService";

import { BankAccountsTable } from "./bank-accounts-table";

const DEFAULT_PER_PAGE = 20;

export default async function BankAccountsPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings.bankAccounts");
  const tSettings = await getTranslations("settings");

  const canManage = auth.roles.includes("org_admin");

  const client = await createServerApiClient();
  const result = await BankAccountService.listBankAccounts(client, {
    page: 1,
    perPage: DEFAULT_PER_PAGE,
    sort: "createdAt",
    order: "desc",
  });

  const hasAny = result.pagination.total > 0;
  const showFeatureFlags = await isFeatureFlagsPhase2Enabled();

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
          canManage ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/settings/bank-accounts/new">
                <Plus size={16} aria-hidden="true" />
                {t("actions.new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <SettingsNavigation showFeatureFlags={showFeatureFlags} />

      {hasAny ? (
        <BankAccountsTable bankAccounts={result.data} canManage={canManage} />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest border border-border-brand">
          <EmptyState
            icon={Banknote}
            title={t("empty.title")}
            description={t("empty.description")}
          />
        </div>
      )}
    </>
  );
}
