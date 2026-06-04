import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { CamtUnreconciledQueue } from "@/components/settings/camt-unreconciled-queue";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import { BankAccountService } from "@/services/BankAccountService";
import {
  CamtStatementsService,
  type CamtUnreconciledReason,
  type CamtUnreconciledStatus,
} from "@/services/CamtStatementsService";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const VALID_REASONS: CamtUnreconciledReason[] = [
  "invalid_ref",
  "no_match",
  "no_debtor_info",
  "orphan_reversal",
  "partial_match",
];

const VALID_STATUSES: CamtUnreconciledStatus[] = ["pending", "resolved", "written_off"];

function readFirst(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function CamtUnreconciledQueuePage({ searchParams }: PageProps) {
  const auth = await requireAuth();
  if (!hasPermission(auth, "write")) notFound();

  const sp = await searchParams;
  const bankAccountId = readFirst(sp.bankAccountId) ?? null;
  const rawReason = readFirst(sp.reason);
  const reason =
    rawReason && VALID_REASONS.includes(rawReason as CamtUnreconciledReason)
      ? (rawReason as CamtUnreconciledReason)
      : null;
  const rawStatus = readFirst(sp.status);
  const status: CamtUnreconciledStatus =
    rawStatus && VALID_STATUSES.includes(rawStatus as CamtUnreconciledStatus)
      ? (rawStatus as CamtUnreconciledStatus)
      : "pending";

  const client = await createServerApiClient();
  const [listResult, bankAccountsResult, t, tSettings] = await Promise.all([
    CamtStatementsService.listUnreconciled(client, {
      bankAccountId: bankAccountId ?? undefined,
      reason: reason ?? undefined,
      status,
      page: 1,
      perPage: 50,
    }).catch(() => ({
      data: [],
      pagination: { page: 1, perPage: 50, total: 0, totalPages: 0 },
    })),
    BankAccountService.listBankAccounts(client, { page: 1, perPage: 100 }).catch(() => ({
      data: [],
      pagination: { page: 1, perPage: 100, total: 0, totalPages: 0 },
    })),
    getTranslations("settings.camtUnreconciled.page"),
    getTranslations("settings"),
  ]);

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("breadcrumb") },
        ]}
      />
      <SettingsNavigation />
      <CamtUnreconciledQueue
        initialRows={listResult.data}
        initialTotal={listResult.pagination.total}
        bankAccounts={bankAccountsResult.data.map((b) => ({
          id: b.id,
          bankName: b.bankName,
          iban: b.iban,
        }))}
        initialBankAccountId={bankAccountId}
        initialReason={reason}
        initialStatus={status}
      />
    </>
  );
}
