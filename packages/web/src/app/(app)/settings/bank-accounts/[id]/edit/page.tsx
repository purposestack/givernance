import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BankAccountForm } from "@/components/settings/bank-account-form";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { BankAccount } from "@/models/bank-account";
import { BankAccountService } from "@/services/BankAccountService";

interface EditBankAccountPageProps {
  params: Promise<{ id: string }>;
}

async function fetchBankAccountOrNotFound(id: string): Promise<BankAccount> {
  const client = await createServerApiClient();
  try {
    return await BankAccountService.getBankAccount(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }
    throw err;
  }
}

export default async function EditBankAccountPage({ params }: EditBankAccountPageProps) {
  const auth = await requireAuth();
  const { id } = await params;
  const bankAccount = await fetchBankAccountOrNotFound(id);

  const t = await getTranslations("settings.bankAccounts");
  const tSettings = await getTranslations("settings");
  const tForm = await getTranslations("settings.bankAccounts.form");

  return (
    <>
      <PageHeader
        title={tForm("editTitle")}
        description={tForm("editSubtitle")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: t("settings"), href: "/settings" },
          { label: t("title"), href: "/settings/bank-accounts" },
          { label: bankAccount.bankName ?? bankAccount.label },
          { label: tForm("breadcrumbEdit") },
        ]}
      />
      <SettingsNavigation />
      {/* ADR-035 rules A1 + E19 — header + sub-nav are static shell; the
          form enters as ONE block (no per-field choreography). */}
      <div className="reveal-item">
        <BankAccountForm
          mode="edit"
          bankAccount={bankAccount}
          canManage={auth.roles.includes("org_admin")}
        />
      </div>
    </>
  );
}
