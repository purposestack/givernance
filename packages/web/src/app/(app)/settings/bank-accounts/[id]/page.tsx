import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { CamtStatementsSection } from "@/components/settings/camt-statements-section";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { BankAccount } from "@/models/bank-account";
import { BankAccountService } from "@/services/BankAccountService";
import {
  type CamtStatementSummary,
  CamtStatementsService,
  maskIban,
  type ReconciliationHealth,
} from "@/services/CamtStatementsService";

interface BankAccountDetailPageProps {
  params: Promise<{ id: string }>;
}

async function fetchBankAccountOrNotFound(id: string): Promise<BankAccount> {
  const client = await createServerApiClient();
  try {
    return await BankAccountService.getBankAccount(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) notFound();
    throw err;
  }
}

async function fetchStatementsOrEmpty(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  bankAccountId: string,
): Promise<CamtStatementSummary[]> {
  try {
    const result = await CamtStatementsService.listStatements(client, {
      bankAccountId,
      page: 1,
      perPage: 20,
    });
    return result.data;
  } catch {
    return [];
  }
}

async function fetchHealthOrNull(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  bankAccountId: string,
): Promise<ReconciliationHealth | null> {
  try {
    return await CamtStatementsService.getReconciliationHealth(client, bankAccountId);
  } catch {
    return null;
  }
}

export default async function BankAccountDetailPage({ params }: BankAccountDetailPageProps) {
  const auth = await requireAuth();
  const { id } = await params;
  const canManage = auth.roles.includes("org_admin");

  if (!canManage) notFound();

  const client = await createServerApiClient();
  const [bankAccount, statements, health, t, tSettings, locale] = await Promise.all([
    fetchBankAccountOrNotFound(id),
    fetchStatementsOrEmpty(client, id),
    fetchHealthOrNull(client, id),
    getTranslations("settings.bankAccounts.detail"),
    getTranslations("settings"),
    getLocale(),
  ]);
  void locale;

  return (
    <>
      <PageHeader
        title={bankAccount.bankName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={bankAccount.ibanKind === "qr_iban" ? "success" : "info"}>
              {bankAccount.ibanKind === "qr_iban" ? "QR-IBAN" : "IBAN"}
            </Badge>
            <span className="font-mono text-xs text-on-surface-variant">
              {maskIban(bankAccount.iban)}
            </span>
            <span className="text-xs text-on-surface-variant">{bankAccount.currency}</span>
          </span>
        }
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("breadcrumbBankAccounts"), href: "/settings/bank-accounts" },
          { label: bankAccount.bankName },
        ]}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/settings/bank-accounts">
                <ArrowLeft size={16} aria-hidden="true" />
                {t("actions.back")}
              </Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href={`/settings/bank-accounts/${bankAccount.id}/edit`}>
                <Pencil size={16} aria-hidden="true" />
                {t("actions.edit")}
              </Link>
            </Button>
          </>
        }
      />
      <SettingsNavigation />

      <section className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("accountCard.title")}</CardTitle>
            <CardDescription>{t("accountCard.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <KeyValue
                label={t("accountCard.iban")}
                value={
                  <span className="font-mono text-sm text-on-surface">
                    {maskIban(bankAccount.iban)}
                  </span>
                }
              />
              <KeyValue
                label={t("accountCard.referenceMode")}
                value={
                  bankAccount.ibanKind === "qr_iban"
                    ? t("accountCard.referenceModeQrr")
                    : t("accountCard.referenceModeScor")
                }
              />
              <KeyValue label={t("accountCard.currency")} value={bankAccount.currency} />
              <KeyValue
                label={t("accountCard.bic")}
                value={
                  bankAccount.bic ? (
                    <span className="font-mono text-sm text-on-surface">{bankAccount.bic}</span>
                  ) : (
                    "—"
                  )
                }
              />
              <KeyValue label={t("accountCard.holderName")} value={bankAccount.holderName} />
              <KeyValue
                label={t("accountCard.holderAddress")}
                value={[
                  bankAccount.holderStreet,
                  bankAccount.holderBuildingNumber,
                  ` · ${bankAccount.holderPostalCode} ${bankAccount.holderTown}`,
                  ` · ${bankAccount.holderCountryCode}`,
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
            </dl>
          </CardContent>
        </Card>

        <div>
          <h2 className="mb-3 font-heading text-2xl text-on-surface">
            {t("statementsHeading.title")}
          </h2>
          <p className="mb-4 text-sm text-on-surface-variant">{t("statementsHeading.lead")}</p>
          <CamtStatementsSection
            bankAccountId={bankAccount.id}
            initialStatements={statements}
            initialHealth={health}
          />
        </div>
      </section>
    </>
  );
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-on-surface">{value}</dd>
    </div>
  );
}
