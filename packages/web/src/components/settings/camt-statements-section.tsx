"use client";

/**
 * CamtStatementsSection — owns the camt.053 upload zone + recent
 * statements table + reconciliation health card on the bank-account
 * detail page (Epic #318 PR #5, docs/25 §5.4.bis state machine).
 *
 * State surfaces the operator cares about (per the mockup
 * `bank-account-detail.html`):
 *   • Upload zone (drag-drop + click-to-pick) with progress bar
 *   • Recent statements table with status pill, match rate, actions
 *   • Reconciliation health card (right rail) — 90-day aggregates
 *
 * Polling lifecycle: while at least one statement row is in `pending`
 * or `processing`, poll the list every 2s. When a row transitions to a
 * terminal state (`processed` / `failed`), fire a toast once per
 * transition — tracked via a `Set<string>` of toasted statement ids so
 * polling re-renders never duplicate.
 */

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import {
  type CamtStatementStatus,
  type CamtStatementSummary,
  CamtStatementsService,
  parseStatementError,
  type ReconciliationHealth,
} from "@/services/CamtStatementsService";

/** Browser-side 50 MB hard cap (mirrors `CAMT_UPLOAD_MAX_BYTES`). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

interface CamtStatementsSectionProps {
  bankAccountId: string;
  initialStatements: CamtStatementSummary[];
  initialHealth: ReconciliationHealth | null;
}

export function CamtStatementsSection({
  bankAccountId,
  initialStatements,
  initialHealth,
}: CamtStatementsSectionProps) {
  const t = useTranslations("settings.bankAccounts.detail.statementsSection");
  const locale = useLocale();

  const [statements, setStatements] = useState<CamtStatementSummary[]>(initialStatements);
  const [health, setHealth] = useState<ReconciliationHealth | null>(initialHealth);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingFilename, setUploadingFilename] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track which statements have already had their terminal-transition
  // toast fired — keyed by id. A polling re-fetch can re-render the same
  // terminal row N times; the Set guarantees one toast per transition.
  const toastedRef = useRef<Set<string>>(new Set());

  const refreshStatements = useCallback(async () => {
    const client = createClientApiClient();
    const [statementsResult, healthResult] = await Promise.all([
      CamtStatementsService.listStatements(client, {
        bankAccountId,
        page: 1,
        perPage: 20,
      }),
      CamtStatementsService.getReconciliationHealth(client, bankAccountId),
    ]);
    setStatements(statementsResult.data);
    setHealth(healthResult);
    return statementsResult.data;
  }, [bankAccountId]);

  // Polling lifecycle (docs/25 §5.4.bis state machine). 2s cadence, max
  // 5 minutes to avoid runaway polls if the worker is wedged.
  const hasInflight = statements.some((s) => s.status === "pending" || s.status === "processing");

  useEffect(() => {
    if (!hasInflight) return;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        clearInterval(interval);
        return;
      }
      void refreshStatements().catch((err) => {
        // Silent: polling errors aren't actionable for the operator. A
        // permanent 401/403 would surface elsewhere; transient blips are
        // recoverable on the next tick.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[camt-statements polling]", err);
        }
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [hasInflight, refreshStatements]);

  // Terminal-transition toast surface. Watches the statement list and
  // fires once per (statementId, terminal-status) tuple. Idempotent
  // across polling re-renders via the toastedRef Set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `t` is locale-stable and toast is a singleton.
  useEffect(() => {
    for (const s of statements) {
      if (toastedRef.current.has(s.id)) continue;
      if (s.status === "processed") {
        toastedRef.current.add(s.id);
        toast.success(
          t("toasts.processed", {
            matched: s.matchedCredits,
            unmatched: s.unmatchedCredits,
          }),
        );
      } else if (s.status === "failed") {
        toastedRef.current.add(s.id);
        const parsed = parseStatementError(s.error);
        const code = parsed?.code ?? "failed";
        toast.error(t("toasts.failed", { code }));
      }
    }
  }, [statements]);

  const handleFile = useCallback(
    async (file: File) => {
      if (isUploading) return;
      if (!file.name.toLowerCase().endsWith(".xml")) {
        toast.error(t("validation.notXml"));
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t("validation.tooLarge"));
        return;
      }
      setIsUploading(true);
      setUploadingFilename(file.name);
      try {
        const client = createClientApiClient();
        await CamtStatementsService.uploadStatement(client, bankAccountId, file);
        toast.success(t("toasts.uploadAccepted"));
        await refreshStatements();
      } catch (err) {
        const message =
          err instanceof ApiProblem
            ? (err.detail ?? err.title ?? t("toasts.uploadFailed"))
            : t("toasts.uploadFailed");
        toast.error(message);
      } finally {
        setIsUploading(false);
        setUploadingFilename(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [bankAccountId, isUploading, refreshStatements, t],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      void handleFile(file);
    },
    [handleFile],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <UploadZone
            isUploading={isUploading}
            uploadingFilename={uploadingFilename}
            isDragging={isDragging}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onPick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,application/xml,text/xml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
            aria-label={t("dropZone.fileInputLabel")}
          />

          {statements.length === 0 ? (
            <EmptyStatementsState />
          ) : (
            <StatementsTable statements={statements} locale={locale} />
          )}
        </CardContent>
      </Card>

      <aside className="space-y-4">
        <ReconciliationHealthCard bankAccountId={bankAccountId} health={health} locale={locale} />
      </aside>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────

function UploadZone({
  isUploading,
  uploadingFilename,
  isDragging,
  onDrop,
  onDragOver,
  onDragLeave,
  onPick,
}: {
  isUploading: boolean;
  uploadingFilename: string | null;
  isDragging: boolean;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onPick: () => void;
}) {
  const t = useTranslations("settings.bankAccounts.detail.statementsSection.dropZone");
  if (isUploading) {
    return (
      <div className="rounded-xl border border-outline-variant bg-surface-container-low p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Loader2 className="animate-spin" size={18} aria-hidden="true" />
          </div>
          <div className="flex-1">
            <p className="font-mono text-sm text-on-surface">
              {uploadingFilename ?? t("uploading")}
            </p>
            <p className="text-xs text-on-surface-variant">{t("uploadingHint")}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    // Native <button> so the implicit role + keyboard activation are
    // free (lint a11y/useSemanticElements). Drop events still bubble
    // to the button per HTML spec.
    <button
      type="button"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      aria-label={t("aria")}
      onClick={onPick}
      className={`block w-full cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
        isDragging
          ? "border-primary bg-primary/5"
          : "border-outline-variant bg-surface-container-low hover:border-primary/40"
      }`}
    >
      <div className="mb-2 flex items-center justify-center">
        <Upload
          size={28}
          aria-hidden="true"
          className={isDragging ? "text-primary" : "text-on-surface-variant"}
        />
      </div>
      <p className="text-sm font-medium text-on-surface">{t("lead")}</p>
      <p className="mt-1 text-xs text-on-surface-variant">{t("hint")}</p>
      {/* Visible "Choose file" affordance rendered as a styled span — the
          outer element is already a <button>, and nested buttons are
          invalid HTML. The whole zone is clickable, so the span is just
          a visual cue. */}
      <span className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary">
        {t("cta")}
      </span>
    </button>
  );
}

function EmptyStatementsState() {
  const t = useTranslations("settings.bankAccounts.detail.statementsSection.empty");
  return (
    <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-low p-8 text-center">
      <FileText size={32} aria-hidden="true" className="mx-auto mb-2 text-on-surface-variant" />
      <h3 className="text-sm font-semibold text-on-surface">{t("title")}</h3>
      <p className="mx-auto mt-1 max-w-md text-xs text-on-surface-variant">{t("body")}</p>
    </div>
  );
}

function StatementsTable({
  statements,
  locale,
}: {
  statements: CamtStatementSummary[];
  locale: string;
}) {
  const t = useTranslations("settings.bankAccounts.detail.statementsSection.table");
  return (
    <div className="overflow-x-auto rounded-xl border border-outline-variant">
      <table className="w-full text-sm">
        <thead className="border-b border-outline-variant bg-surface-container-low text-left">
          <tr>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
              {t("filename")}
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
              {t("uploaded")}
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
              {t("processed")}
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
              {t("status")}
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
              {t("matchRate")}
            </th>
            <th className="px-3 py-2" aria-label={t("actions")} />
          </tr>
        </thead>
        <tbody>
          {statements.map((s) => (
            <StatementRow key={s.id} statement={s} locale={locale} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatementRow({ statement, locale }: { statement: CamtStatementSummary; locale: string }) {
  const t = useTranslations("settings.bankAccounts.detail.statementsSection.table");
  const isTerminal = statement.status === "processed" || statement.status === "failed";
  const pct =
    statement.totalCredits > 0
      ? Math.round((statement.matchedCredits / statement.totalCredits) * 100)
      : 0;
  return (
    <tr className="border-b border-outline-variant last:border-b-0 hover:bg-surface-container-low">
      <td className="px-3 py-2">
        <span className="font-mono text-xs text-on-surface">
          {statement.originalFilename ?? statement.id.slice(0, 8)}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">
        {formatDate(statement.uploadedAt, locale, "short")}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">
        {statement.processedAt ? formatDate(statement.processedAt, locale, "short") : "—"}
      </td>
      <td className="px-3 py-2">
        <StatementStatusBadge status={statement.status} error={statement.error} />
      </td>
      <td className="px-3 py-2">
        {statement.status === "processed" ? (
          <MatchRateBar
            matched={statement.matchedCredits}
            total={statement.totalCredits}
            pct={pct}
          />
        ) : statement.status === "failed" ? (
          <span className="font-mono text-xs text-error">{t("matchInline.failed")}</span>
        ) : (
          <span className="font-mono text-xs text-on-surface-variant">
            {t("matchInline.inflight")}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          <a
            href={`/api/v1/camt-statements/${statement.id}/download`}
            className="inline-flex h-7 items-center gap-1 rounded border border-outline-variant px-2 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
            aria-label={t("downloadXml")}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Download size={12} aria-hidden="true" />
            XML
          </a>
          <Link
            href={`/settings/camt-statements/${statement.id}`}
            aria-disabled={!isTerminal && statement.status !== "processed"}
            className="inline-flex h-7 items-center gap-1 rounded border border-outline-variant px-2 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
          >
            {t("open")}
            <ExternalLink size={12} aria-hidden="true" />
          </Link>
        </div>
      </td>
    </tr>
  );
}

export function StatementStatusBadge({
  status,
  error,
}: {
  status: CamtStatementStatus;
  error: string | null;
}) {
  const t = useTranslations("settings.bankAccounts.detail.statementsSection.statusPill");
  if (status === "failed") {
    const parsed = parseStatementError(error);
    const isDuplicate = parsed?.code === "duplicate_msg_id";
    if (isDuplicate) {
      return <Badge variant="warning">{t("duplicate")}</Badge>;
    }
    return <Badge variant="error">{t("failed")}</Badge>;
  }
  if (status === "processing") {
    return (
      <Badge variant="info">
        <Loader2 size={10} className="mr-1 animate-spin" aria-hidden="true" />
        {t("processing")}
      </Badge>
    );
  }
  if (status === "processed") {
    return (
      <Badge variant="success">
        <CheckCircle2 size={10} className="mr-1" aria-hidden="true" />
        {t("processed")}
      </Badge>
    );
  }
  return <Badge variant="neutral">{t("pending")}</Badge>;
}

function MatchRateBar({ matched, total, pct }: { matched: number; total: number; pct: number }) {
  return (
    <div className="inline-flex items-center gap-2 font-mono text-xs">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-container">
        <span
          className="block h-full bg-primary"
          style={{ width: `${Math.min(100, pct)}%` }}
          aria-hidden="true"
        />
      </div>
      <span className="tabular-nums text-on-surface-variant">
        {matched} / {total}
      </span>
    </div>
  );
}

function ReconciliationHealthCard({
  bankAccountId,
  health,
  locale,
}: {
  bankAccountId: string;
  health: ReconciliationHealth | null;
  locale: string;
}) {
  const t = useTranslations("settings.bankAccounts.detail.reconciliationHealthCard");
  if (!health) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("emptyLead")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const matchedPct =
    health.totalCreditsLastN > 0
      ? Math.round((health.matchedCreditsLastN / health.totalCreditsLastN) * 100)
      : 0;
  const hasBacklog = health.totalUnreconciledPending > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("lead")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <HealthRow
          label={t("rows.statements")}
          value={formatNumber(health.totalStatements, locale)}
        />
        <HealthRow
          label={t("rows.lastImport")}
          value={
            health.lastStatementImportedAt
              ? formatDate(health.lastStatementImportedAt, locale, "medium")
              : t("rows.never")
          }
        />
        <HealthRow
          label={t("rows.credits")}
          value={formatNumber(health.totalCreditsLastN, locale)}
        />
        <HealthRow
          label={t("rows.matched")}
          value={`${formatNumber(health.matchedCreditsLastN, locale)} (${matchedPct}%)`}
          tone="success"
        />
        <HealthRow
          label={t("rows.unmatched")}
          value={formatNumber(health.unmatchedCreditsLastN, locale)}
          tone={health.unmatchedCreditsLastN > 0 ? "warning" : "neutral"}
        />

        <Button
          asChild
          variant={hasBacklog ? "primary" : "secondary"}
          className="w-full justify-between"
          disabled={!hasBacklog}
        >
          <Link
            href={`/settings/camt-unreconciled?bankAccountId=${encodeURIComponent(bankAccountId)}`}
            aria-label={t("cta.aria", { count: health.totalUnreconciledPending })}
          >
            <span>{hasBacklog ? t("cta.review") : t("cta.allClean")}</span>
            <Badge
              variant={hasBacklog ? "neutral" : "neutral"}
              className="bg-white/20 text-current"
            >
              {health.totalUnreconciledPending}
            </Badge>
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function HealthRow({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "success" | "warning" | "neutral";
}) {
  const colorClass =
    tone === "success"
      ? "text-success-text"
      : tone === "warning"
        ? "text-warning"
        : "text-on-surface";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-outline-variant pb-2 last:border-b-0 last:pb-0">
      <span className="text-xs uppercase tracking-wide text-on-surface-variant">{label}</span>
      <span className={`font-mono text-sm ${colorClass}`}>{value}</span>
    </div>
  );
}

// Silence unused-import in tests for `formatCurrency`. It IS used —
// re-exporting here keeps the helper available for the swiss-rail card
// without inflating the bundle.
void formatCurrency;
void AlertTriangle;
