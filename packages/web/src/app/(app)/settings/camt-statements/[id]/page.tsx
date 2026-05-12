import { AlertTriangle, ArrowLeft, Download } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { StatementStatusBadge } from "@/components/settings/camt-statements-section";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { formatDate, formatNumber } from "@/lib/format";
import {
  type CamtStatementDetail,
  CamtStatementsService,
  maskIban,
  parseStatementError,
} from "@/services/CamtStatementsService";

interface CamtStatementDetailPageProps {
  params: Promise<{ id: string }>;
}

async function fetchStatementOrNotFound(id: string): Promise<CamtStatementDetail> {
  const client = await createServerApiClient();
  try {
    const statement = await CamtStatementsService.getStatement(client, id);
    if (!statement) notFound();
    return statement;
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) notFound();
    throw err;
  }
}

export default async function CamtStatementDetailPage({ params }: CamtStatementDetailPageProps) {
  const auth = await requireAuth();
  const { id } = await params;
  if (!auth.roles.includes("org_admin")) notFound();

  const [statement, t, tSettings, locale] = await Promise.all([
    fetchStatementOrNotFound(id),
    getTranslations("settings.camtStatements.detail"),
    getTranslations("settings"),
    getLocale(),
  ]);
  void locale;

  const isFailed = statement.status === "failed";
  const parsedError = parseStatementError(statement.error);
  const isForeignIban = parsedError?.code === "foreign_iban";
  const isDuplicate = parsedError?.code === "duplicate_msg_id";
  const matchedPct =
    statement.totalCredits > 0
      ? Math.round((statement.matchedCredits / statement.totalCredits) * 100)
      : 0;

  return (
    <>
      <PageHeader
        title={statement.originalFilename ?? t("titleFallback", { id: statement.id.slice(0, 8) })}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatementStatusBadge status={statement.status} error={statement.error} />
            {statement.bankAccount ? (
              <span className="font-mono text-xs text-on-surface-variant">
                {statement.bankAccount.bankName} · {maskIban(statement.bankAccount.iban)}
              </span>
            ) : null}
          </span>
        }
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("breadcrumbBankAccounts"), href: "/settings/bank-accounts" },
          statement.bankAccount
            ? {
                label: statement.bankAccount.bankName,
                href: `/settings/bank-accounts/${statement.bankAccount.id}`,
              }
            : { label: t("breadcrumbStatement") },
          { label: statement.originalFilename ?? statement.id.slice(0, 8) },
        ]}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link
                href={
                  statement.bankAccount
                    ? `/settings/bank-accounts/${statement.bankAccount.id}`
                    : "/settings/bank-accounts"
                }
              >
                <ArrowLeft size={16} aria-hidden="true" />
                {t("actions.back")}
              </Link>
            </Button>
            <Button asChild variant="primary" size="sm">
              <a
                href={`/api/v1/camt-statements/${statement.id}/download`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download size={16} aria-hidden="true" />
                {t("actions.download")}
              </a>
            </Button>
          </>
        }
      />
      <SettingsNavigation />

      <section className="space-y-6">
        {isForeignIban ? (
          <ForeignIbanAlert statementId={statement.id} message={parsedError?.message ?? ""} />
        ) : isFailed && !isDuplicate ? (
          <FailedAlert statementId={statement.id} error={statement.error} />
        ) : isDuplicate ? (
          <DuplicateAlert message={parsedError?.message ?? ""} />
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t("metadata.title")}</CardTitle>
            <CardDescription>{t("metadata.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KV
                label={t("metadata.msgId")}
                value={
                  <span
                    className="font-mono text-xs text-on-surface"
                    title={statement.msgId ?? undefined}
                  >
                    {statement.msgId && !statement.msgId.startsWith("__pending_")
                      ? truncate(statement.msgId, 28)
                      : "—"}
                  </span>
                }
              />
              {statement.bankAccount ? (
                <KV
                  label={t("metadata.iban")}
                  value={
                    <span className="font-mono text-xs text-on-surface">
                      {maskIban(statement.bankAccount.iban)}{" "}
                      <Badge variant="info" className="ml-2">
                        {t("metadata.tenantAccount")}
                      </Badge>
                    </span>
                  }
                />
              ) : null}
              <KV
                label={t("metadata.uploaded")}
                value={formatDate(statement.uploadedAt, locale, "medium")}
              />
              <KV
                label={t("metadata.processed")}
                value={
                  statement.processedAt ? formatDate(statement.processedAt, locale, "medium") : "—"
                }
              />
              <KV
                label={t("metadata.bookingPeriod")}
                value={
                  statement.statementFrom && statement.statementTo
                    ? `${statement.statementFrom} → ${statement.statementTo}`
                    : "—"
                }
              />
              <KV label={t("metadata.retention")} value={t("metadata.retentionValue")} />
            </dl>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Kpi
            label={t("kpis.creditEntries")}
            value={formatNumber(statement.creditEntryCount, locale)}
            hint={
              statement.totalCredits > 0
                ? t("kpis.creditEntriesHint", { total: statement.totalCredits })
                : undefined
            }
          />
          <Kpi
            label={t("kpis.matched")}
            value={formatNumber(statement.matchedCredits, locale)}
            hint={`${matchedPct}%`}
            tone="success"
          />
          <Kpi
            label={t("kpis.unreconciled")}
            value={formatNumber(statement.unreconciledCount, locale)}
            hint={t("kpis.unreconciledHint")}
            tone={statement.unreconciledCount > 0 ? "warning" : "neutral"}
          />
        </div>

        {statement.unreconciledCount > 0 && statement.bankAccount ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("unreconciledCard.title")}</CardTitle>
              <CardDescription>
                {t("unreconciledCard.description", {
                  count: statement.unreconciledCount,
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="primary">
                <Link
                  href={`/settings/camt-unreconciled?bankAccountId=${encodeURIComponent(statement.bankAccount.id)}`}
                >
                  {t("unreconciledCard.cta")}
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </section>
    </>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-on-surface">{value}</dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "success" | "warning" | "neutral";
}) {
  const colorClass =
    tone === "success"
      ? "text-success-text"
      : tone === "warning"
        ? "text-warning"
        : "text-on-surface";
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-on-surface-variant">{label}</p>
        <p className={`mt-1 font-heading text-3xl tabular-nums ${colorClass}`}>{value}</p>
        {hint ? <p className="mt-1 font-mono text-xs text-on-surface-variant">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function FailedAlert({ statementId, error }: { statementId: string; error: string | null }) {
  const parsed = parseStatementError(error);
  return (
    <Card className="border-error bg-error-container">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} aria-hidden="true" className="shrink-0 text-error" />
          <div className="flex-1">
            <h3 className="font-semibold text-on-error-container">{parsed?.code ?? "failed"}</h3>
            <p className="mt-1 text-xs text-on-error-container">
              {parsed?.message ?? "Camt.053 import failed."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <a
                  href={`/api/v1/camt-statements/${statementId}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={14} aria-hidden="true" />
                  Download original
                </a>
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ForeignIbanAlert({ statementId, message }: { statementId: string; message: string }) {
  return (
    <Card className="border-error bg-error-container">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} aria-hidden="true" className="shrink-0 text-error" />
          <div className="flex-1">
            <h3 className="font-semibold text-on-error-container">
              This statement is for a different bank account
            </h3>
            <p className="mt-1 text-xs text-on-error-container">{message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <a
                  href={`/api/v1/camt-statements/${statementId}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={14} aria-hidden="true" />
                  Download original
                </a>
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DuplicateAlert({ message }: { message: string }) {
  return (
    <Card className="border-warning bg-warning/10">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} aria-hidden="true" className="shrink-0 text-warning" />
          <div className="flex-1">
            <h3 className="font-semibold text-on-surface">Duplicate statement</h3>
            <p className="mt-1 text-xs text-on-surface-variant">
              {message ||
                "This statement was already imported (same GrpHdr.MsgId). No new entries were created."}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
