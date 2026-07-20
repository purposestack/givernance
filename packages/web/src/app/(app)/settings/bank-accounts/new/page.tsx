import { getTranslations } from "next-intl/server";

import { BankAccountForm } from "@/components/settings/bank-account-form";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";

export default async function NewBankAccountPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings.bankAccounts");
  const tSettings = await getTranslations("settings");
  const tForm = await getTranslations("settings.bankAccounts.form");

  return (
    <>
      <PageHeader
        title={tForm("createTitle")}
        description={tForm("createSubtitle")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: t("settings"), href: "/settings" },
          { label: t("title"), href: "/settings/bank-accounts" },
          { label: tForm("breadcrumbNew") },
        ]}
      />
      <SettingsNavigation />
      {/* ADR-035 rules A1 + E19 — header + sub-nav are static shell; the
          form enters as ONE block (no per-field choreography). */}
      <div className="reveal-item">
        <BankAccountForm mode="create" canManage={auth.roles.includes("org_admin")} />
      </div>
    </>
  );
}
