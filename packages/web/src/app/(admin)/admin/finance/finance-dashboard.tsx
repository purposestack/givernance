"use client";

/**
 * Super-admin finance dashboard — direct port of the Claude Design mockup
 * (docs/design/admin/dashboard.html) into JSX with dynamic data slots.
 *
 * First-pass strategy: keep the mockup markup verbatim (same class names,
 * same DOM structure) for guaranteed visual parity. Componentization
 * will follow in a separate PR once visual fidelity is validated.
 */

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  SurveyLaunchCard,
  type SurveyLaunchCardLabels,
  toast,
  VolumeRevenueChart,
} from "@/components/admin/finance";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { createClientApiClient } from "@/lib/api/client-browser";
import { formatMonthName, formatMonthYear } from "@/lib/format";
import type {
  FinancePeriod,
  FinanceSummary,
  MonthlyReport,
  SurveyCadence,
} from "@/models/superadmin-finance";
import { SuperAdminFinanceService } from "@/services/SuperAdminFinanceService";
import { groupReportsByYear } from "./report-archive-grouping";

import "./finance-mockup.css";

interface FinanceDashboardProps {
  initialSummary: FinanceSummary | null;
  initialError: boolean;
}

const PERIOD_VALUES = [
  { value: "today" as FinancePeriod, key: "period.today" as const },
  { value: "7d" as FinancePeriod, key: "period.7d" as const },
  { value: "30d" as FinancePeriod, key: "period.30d" as const },
  { value: "90d" as FinancePeriod, key: "period.90d" as const },
  { value: "ytd" as FinancePeriod, key: "period.ytd" as const },
];

function formatCents(cents: number, currency = "EUR", showCents = true): string {
  const amount = cents / 100;
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(amount);
}

function splitCurrency(cents: number, currency = "EUR"): { main: string; suffix: string } {
  const formatted = formatCents(cents, currency);
  const match = formatted.match(/^(.+)([,.])(\d{2})\s*(.*)$/);
  if (!match) return { main: formatted, suffix: "" };
  return { main: match[1] ?? formatted, suffix: `${match[2]}${match[3]}` };
}

function formatPercent(value: number, digits = 1): string {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function formatShortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function deltaPillVariant(percent: number, isCost = false): "up" | "down" | "flat" | "cost" {
  if (Math.abs(percent) < 0.05) return "flat";
  if (isCost && percent > 0) return "cost";
  return percent > 0 ? "up" : "down";
}

function deltaPillIcon(variant: "up" | "down" | "flat" | "cost"): string {
  if (variant === "up") return "arrow_upward";
  if (variant === "down") return "arrow_downward";
  if (variant === "cost") return "trending_up";
  return "remove";
}

function gradeClass(grade: string | null): string {
  if (!grade) return "g-c";
  const map: Record<string, string> = { "A+": "g-aplus", A: "g-a", B: "g-b", C: "g-c", D: "g-d" };
  return map[grade] ?? "g-c";
}

function heroGradeClass(grade: string | null): string {
  if (!grade) return "hero-grade--c";
  const map: Record<string, string> = {
    "A+": "hero-grade--aplus",
    A: "hero-grade--a",
    B: "hero-grade--b",
    C: "hero-grade--c",
    D: "hero-grade--d",
  };
  return map[grade] ?? "hero-grade--c";
}

interface FinanceFilters {
  currency: "all" | "EUR" | "GBP" | "CHF";
  tenantId: "all" | string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: first-pass mockup port; section extraction + componentization is the follow-up (iterating on visual fidelity is easier with one file end-to-end).
export function FinanceDashboard({ initialSummary, initialError }: FinanceDashboardProps) {
  const [period, setPeriod] = useState<FinancePeriod>("30d");
  const [filters, setFilters] = useState<FinanceFilters>({ currency: "all", tenantId: "all" });
  const [summary, setSummary] = useState<FinanceSummary | null>(initialSummary);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<boolean>(initialError);
  const [flushing, setFlushing] = useState(false);
  const t = useTranslations("admin.finance");

  const periodOptions: Array<{ value: FinancePeriod; label: string }> = PERIOD_VALUES.map(
    ({ value, key }) => ({ value, label: t(key) }),
  );

  const handlePeriodChange = useCallback((next: FinancePeriod) => setPeriod(next), []);

  const handleFlushCache = useCallback(async () => {
    if (flushing) return;
    setFlushing(true);
    try {
      const api = createClientApiClient();
      const result = await SuperAdminFinanceService.flushCache(api);
      toast.success(t("cacheFlush.successToast", { keysDeleted: result.keysDeleted }));
      // Re-fetch with current period/filters to populate the freshly-
      // flushed cache and update the view.
      const data = await SuperAdminFinanceService.fetchSummary(api, {
        period,
        currency: filters.currency === "all" ? undefined : filters.currency,
        tenantId: filters.tenantId === "all" ? undefined : filters.tenantId,
      });
      setSummary(data);
    } catch {
      toast.error(t("cacheFlush.errorToast"));
    } finally {
      setFlushing(false);
    }
  }, [flushing, period, filters.currency, filters.tenantId, t]);
  // ─── Manual survey launch (issue #444) ────────────────────────────────────
  // Server enforces cooldown + idempotency; we react to 429 with a
  // clear toast instead of pre-disabling. See SurveyLaunchCard for the
  // full rationale.
  const handleLaunchSurvey = useCallback(
    async (slug: string, channel: "email" | "in_app", idempotencyKey: string) => {
      const api = createClientApiClient();
      const result = await SuperAdminFinanceService.launchSurvey(
        api,
        slug,
        { channel },
        idempotencyKey,
      );
      return { recipientCount: result.recipientCount };
    },
    [],
  );
  const handleScheduleSurvey = useCallback(async (slug: string, cadence: SurveyCadence) => {
    const api = createClientApiClient();
    await SuperAdminFinanceService.scheduleSurvey(api, slug, { cadence });
  }, []);

  const handleCurrencyChange = useCallback(
    (next: FinanceFilters["currency"]) => setFilters((f) => ({ ...f, currency: next })),
    [],
  );
  const handleTenantChange = useCallback(
    (next: FinanceFilters["tenantId"]) => setFilters((f) => ({ ...f, tenantId: next })),
    [],
  );

  // ─── CSV export (issue #442) ──────────────────────────────────────────────
  // Triggers the download via a synthetic `<a download>` click rather
  // than `window.location.assign`. The anchor click never unloads the
  // dashboard even if the server 4xx/5xx's — the browser just doesn't
  // start a download. Same SameSite=Lax cookie behaviour as a top-level
  // GET navigation, no CSRF concern (read-only export).
  const handleExportCsv = useCallback(() => {
    const api = createClientApiClient();
    const url = SuperAdminFinanceService.buildSummaryCsvUrl(api, {
      period,
      currency: filters.currency === "all" ? undefined : filters.currency,
      tenantId: filters.tenantId === "all" ? undefined : filters.tenantId,
    });
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    // `download` is advisory — the server's Content-Disposition is the
    // authoritative filename.
    a.setAttribute("download", "");
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.success(t("exportCsv.successToast"));
  }, [period, filters.currency, filters.tenantId, t]);

  // ─── Monthly PDF report (issue #443) ──────────────────────────────────────
  // The button is on the page header. Click → POST → poll the row by id
  // every 2s until `ready` (or `failed`), then trigger a same-tab
  // navigation to the streamed PDF URL.
  const [reportBusy, setReportBusy] = useState(false);
  const [reports, setReports] = useState<MonthlyReport[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Holds the report row whose regenerate-confirmation dialog is open.
  // Single-slot — only one regeneration can be running at a time
  // (gated by `reportBusy`).
  const [reportToRegenerate, setReportToRegenerate] = useState<MonthlyReport | null>(null);

  // Group the archive rows by calendar year for a scannable, sectioned list.
  const reportsByYear = useMemo(() => groupReportsByYear(reports), [reports]);

  const refreshReports = useCallback(async () => {
    try {
      const api = createClientApiClient();
      const rows = await SuperAdminFinanceService.listReports(api);
      setReports(rows);
    } catch {
      // Non-fatal — the archive panel just stays empty.
    }
  }, []);

  // Lazy-fetch the archive list when the panel is first opened.
  useEffect(() => {
    if (archiveOpen && reports.length === 0) {
      void refreshReports();
    }
  }, [archiveOpen, reports.length, refreshReports]);

  // Auto-refresh the archive while any row is `pending` — picks up the
  // worker's status flip without making the user reopen the panel.
  // Stops itself as soon as every visible row is settled (ready /
  // failed). Bounded by the panel being open so a backgrounded tab
  // doesn't poll forever.
  useEffect(() => {
    if (!archiveOpen) return;
    const hasPending = reports.some((r) => r.status === "pending");
    if (!hasPending) return;
    const interval = setInterval(() => {
      void refreshReports();
    }, 3000);
    return () => clearInterval(interval);
  }, [archiveOpen, reports, refreshReports]);

  // Status feedback uses the platform sonner Toaster (mounted once in
  // the root layout). Sticky in-progress notifications use
  // `toast.loading(...)` which returns an id that we resolve into a
  // success / error toast with the same id when work completes. This
  // replaces an earlier inline `<p>` banner that lived inside the
  // page header and squeezed the title/subtitle to the left when
  // shown (feedback 2026-05-26).

  // Request a regeneration — just opens the design-system AlertDialog;
  // the actual work happens in `confirmRegenerate` only after the
  // user confirms. Split this way so the confirmation lives in our
  // own UI (with brand styling + i18n + a11y) instead of the
  // platform-styled `window.confirm`.
  const requestRegenerate = useCallback(
    (report: MonthlyReport) => {
      if (reportBusy) return;
      setReportToRegenerate(report);
    },
    [reportBusy],
  );

  const confirmRegenerate = useCallback(async () => {
    const report = reportToRegenerate;
    if (!report || reportBusy) return;
    setReportBusy(true);
    setReportToRegenerate(null);
    const toastId = toast.loading(t("reports.messageRegenerating", { month: report.month }));
    // Surface the archive panel so the user can watch the new row
    // tick from `pending` to `ready` via the watcher useEffect.
    setArchiveOpen(true);
    try {
      const api = createClientApiClient();
      const result = await SuperAdminFinanceService.regenerateReport(api, report.id);
      void refreshReports();

      // Poll the newly-created report (initially `pending`) until
      // the worker flips it to `ready` or `failed`. Same 2s cadence
      // and 60-attempt ceiling as the main "Rapport mensuel" flow.
      let polled = result.newReport;
      for (let attempt = 0; attempt < 60 && polled.status === "pending"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        polled = await SuperAdminFinanceService.fetchReport(api, polled.id);
      }

      if (polled.status === "ready") {
        toast.success(
          t("reports.messageRegenerated", {
            month: report.month,
            shortId: result.supersededReport.id.slice(0, 8),
          }),
          { id: toastId },
        );
        void refreshReports();
      } else if (polled.status === "failed") {
        toast.error(
          polled.failureReason
            ? t("reports.messageFailed", { reason: polled.failureReason })
            : t("reports.messageFailedGeneric"),
          { id: toastId },
        );
      } else {
        // Still pending after the poll window — surface the wait
        // hint instead of silently dropping the "in-progress" state.
        toast.error(t("reports.messagePendingTimeout"), { id: toastId });
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? t("reports.messageRegenerateError", { error: err.message })
          : t("reports.messageRegenerateErrorGeneric"),
        { id: toastId },
      );
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, reportToRegenerate, refreshReports, t]);

  const handleBackfillReports = useCallback(async () => {
    if (reportBusy) return;
    setReportBusy(true);
    const toastId = toast.loading(t("reports.messageBackfillRunning"));
    const api = createClientApiClient();
    try {
      const result = await SuperAdminFinanceService.backfillReports(api);
      toast.success(
        t("reports.messageBackfillDone", {
          enqueued: result.enqueued.length,
          skipped: result.skipped.length,
        }),
        { id: toastId },
      );
      void refreshReports();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? t("reports.messageBackfillError", { error: err.message })
          : t("reports.messageBackfillErrorGeneric"),
        { id: toastId },
      );
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, refreshReports, t]);

  const handleGenerateMonthlyReport = useCallback(async () => {
    if (reportBusy) return;
    setReportBusy(true);
    const toastId = toast.loading(t("reports.messageGenerating"));
    const api = createClientApiClient();
    try {
      let report = await SuperAdminFinanceService.requestMonthlyReport(api);
      // Poll every 2s up to 60 attempts (~2 min). The generation is
      // typically sub-5s — this bound is the DLQ-candidate cutoff.
      for (let attempt = 0; attempt < 60 && report.status === "pending"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        report = await SuperAdminFinanceService.fetchReport(api, report.id);
      }
      if (report.status === "ready" && report.pdfUrl) {
        const absoluteUrl = api.resolveBrowserUrl(report.pdfUrl);
        toast.success(t("reports.messageReady", { month: report.month }), { id: toastId });
        window.location.assign(absoluteUrl);
        void refreshReports();
      } else if (report.status === "failed") {
        toast.error(
          report.failureReason
            ? t("reports.messageFailed", { reason: report.failureReason })
            : t("reports.messageFailedGeneric"),
          { id: toastId },
        );
      } else {
        toast.error(t("reports.messagePendingTimeout"), { id: toastId });
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? t("reports.messageGenerationError", { error: err.message })
          : t("reports.messageGenerationErrorGeneric"),
        { id: toastId },
      );
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, refreshReports, t]);

  // Tracks whether the user has interacted with the period / filter
  // controls since mount. The initial SSR fetch already loaded the
  // 30d default; we skip the duplicate client fetch on first mount
  // ONLY. After any interaction the skip lifts — otherwise navigating
  // 30d → 90d → 30d would show stale 90d data labelled '30j' because
  // the initialSummary check would still match (period back to 30d,
  // initialSummary still truthy) and the refetch would be skipped.
  const hasInteractedRef = useRef(false);

  useEffect(() => {
    if (
      !hasInteractedRef.current &&
      period === "30d" &&
      filters.currency === "all" &&
      filters.tenantId === "all" &&
      initialSummary &&
      !error
    ) {
      return;
    }
    hasInteractedRef.current = true;
    let cancelled = false;
    setLoading(true);
    const api = createClientApiClient();
    SuperAdminFinanceService.fetchSummary(api, {
      period,
      currency: filters.currency === "all" ? undefined : filters.currency,
      tenantId: filters.tenantId === "all" ? undefined : filters.tenantId,
    })
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, filters.currency, filters.tenantId, initialSummary, error]);

  const tenantCount = summary?.mobilisation.perTenant.length ?? 0;
  const lastTimestamp = useMemo(() => {
    // Recompute on every summary refresh — the timestamp shown is "now"
    // at render-of-this-summary time, which is exactly what the live pip
    // should display. `summary` IS used (as the trigger) even though
    // it's not referenced inside.
    void summary;
    const now = new Date();
    return now.toLocaleString("fr-FR", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [summary]);

  const staleSourcesCount = useMemo(() => {
    if (!summary) return 0;
    const now = Date.now();
    return summary.surveys.filter((s) => {
      if (!s.lastCollectedAt) return true;
      const ageDays = (now - new Date(s.lastCollectedAt).getTime()) / (1000 * 60 * 60 * 24);
      const staleThreshold = s.kind === "csat" ? 90 : 180;
      return ageDays > staleThreshold;
    }).length;
  }, [summary]);

  if (error && !summary) {
    return (
      <main>
        <h1 className="page-title">
          {t("pageTitlePrefix")} <em>{t("pageTitleEm")}</em>
        </h1>
        <div role="alert" style={{ padding: 24, color: "var(--color-error)" }}>
          {t("fetchError.title")}. {t("fetchError.body")}
        </div>
      </main>
    );
  }

  if (!summary) {
    return (
      <main>
        <h1 className="page-title">
          {t("pageTitlePrefix")} <em>{t("pageTitleEm")}</em>
        </h1>
        <p style={{ color: "var(--color-on-surface-variant)" }}>{t("loading")}</p>
      </main>
    );
  }

  const { kpis, mobilisation } = summary;
  const isEmpty = kpis.volumeCents === 0 && summary.perTenant.length === 0;

  const heroGrade = mobilisation.platformGrade;
  const heroScore = Math.round(mobilisation.platformScore ?? 0);
  const componentRows: Array<{ label: string; pct: number; weight: number; color: string }> = [
    {
      label: t("formula.activation"),
      pct: Math.round(mobilisation.components.activation),
      weight: 25,
      color: "var(--color-primary)",
    },
    {
      label: t("formula.recurrence"),
      pct: Math.round(mobilisation.components.recurrence),
      weight: 25,
      color: "var(--color-primary-fixed-dim)",
    },
    {
      label: t("formula.scale"),
      pct: Math.round(mobilisation.components.scale),
      weight: 20,
      color: "var(--color-secondary)",
    },
    {
      label: t("formula.growth"),
      pct: Math.round(mobilisation.components.growth),
      weight: 20,
      color: "var(--color-tertiary)",
    },
    {
      label: t("formula.diversity"),
      pct: Math.round(mobilisation.components.diversity),
      weight: 10,
      color: "var(--color-indigo)",
    },
  ];

  const gradeBuckets: Array<{ key: string; count: number; color: string }> = (() => {
    const counts: Record<string, number> = { "A+": 0, A: 0, B: 0, C: 0, D: 0 };
    for (const tenant of mobilisation.perTenant) {
      if (tenant.grade && counts[tenant.grade] !== undefined) {
        counts[tenant.grade] = (counts[tenant.grade] ?? 0) + 1;
      }
    }
    const colors: Record<string, string> = {
      "A+": "var(--color-primary)",
      A: "var(--color-primary-fixed-dim)",
      B: "var(--color-tertiary)",
      C: "var(--color-tertiary-fixed-dim)",
      D: "var(--color-error)",
    };
    return (["A+", "A", "B", "C", "D"] as const).map((k) => ({
      key: k,
      count: counts[k] ?? 0,
      color: colors[k] ?? "",
    }));
  })();
  const maxBucket = Math.max(1, ...gradeBuckets.map((b) => b.count));

  const atRiskCount = mobilisation.perTenant.filter(
    (tenant) => tenant.grade === "D" || (tenant.grade === "C" && (tenant.score ?? 100) < 50),
  ).length;

  const volumeDelta = kpis.deltas.volumePercent;
  const revenueDelta = kpis.deltas.platformFeePercent;
  const stripeDelta = kpis.deltas.stripeFeePercent ?? 0;
  const takeRate = kpis.volumeCents > 0 ? (kpis.platformFeeCents / kpis.volumeCents) * 100 : 0;
  const recurringRatio =
    kpis.volumeCents > 0 ? (kpis.recurringMrrCents / kpis.volumeCents) * 100 : 0;
  const stripeSharePercent =
    kpis.volumeCents > 0 && kpis.stripeFeeCents !== null
      ? (kpis.stripeFeeCents / kpis.volumeCents) * 100
      : 0;

  const volumeKpi = splitCurrency(kpis.volumeCents);
  const revenueKpi = splitCurrency(kpis.platformFeeCents);
  const recurringKpi = splitCurrency(kpis.recurringMrrCents);
  const stripeKpi =
    kpis.stripeFeeCents !== null ? splitCurrency(kpis.stripeFeeCents) : { main: "—", suffix: "" };

  const topTenants = [...summary.perTenant]
    .sort((a, b) => b.volumeCents - a.volumeCents)
    .slice(0, 5);

  const totalCurrencyVolume = summary.perCurrency.reduce((sum, c) => sum + c.volumeCents, 0);

  const refundPct = kpis.volumeCents > 0 ? (kpis.refundedVolumeCents / kpis.volumeCents) * 100 : 0;
  const refundCursorPct = Math.min(100, Math.max(0, (refundPct / 8) * 100));

  const hhi = kpis.hhi;
  const hhiVariant: "ok" | "watch" | "alert" = hhi < 0.15 ? "ok" : hhi < 0.25 ? "watch" : "alert";
  const failureRate = kpis.paymentFailureRate ?? 0;

  const pmfSurvey = summary.surveys.find((s) => s.kind === "pmf");
  const npsSurvey = summary.surveys.find((s) => s.kind === "nps");
  const csatSurvey = summary.surveys.find((s) => s.kind === "csat");
  const pmfPercent = pmfSurvey?.pmfPercent ?? null;
  const pmfFreshness = computeFreshness(pmfSurvey?.lastCollectedAt ?? null, "quarterly");
  const npsFreshness = computeFreshness(npsSurvey?.lastCollectedAt ?? null, "quarterly");
  const csatFreshness = computeFreshness(csatSurvey?.lastCollectedAt ?? null, "continuous");

  const surveyLaunchLabels: SurveyLaunchCardLabels = {
    title: t("surveysLaunch.title"),
    subtitle: t("surveysLaunch.subtitle"),
    pmfLabel: t("surveysLaunch.pmfLabel"),
    npsLabel: t("surveysLaunch.npsLabel"),
    csatLabel: t("surveysLaunch.csatLabel"),
    responseCount: (count) => t("surveysLaunch.responseCount", { count }),
    lastCollectedAt: (date) => t("surveysLaunch.lastCollectedAt", { date }),
    lastCollectedNever: t("surveysLaunch.lastCollectedNever"),
    nextScheduledAt: (date) => t("surveysLaunch.nextScheduledAt", { date }),
    nextScheduledNever: t("surveysLaunch.nextScheduledNever"),
    launchEmail: t("surveysLaunch.launchEmail"),
    launchInApp: t("surveysLaunch.launchInApp"),
    changeCadence: t("surveysLaunch.changeCadence"),
    toastLaunching: t("surveysLaunch.toastLaunching"),
    toastLaunched: (recipientCount) => t("surveysLaunch.toastLaunched", { count: recipientCount }),
    toastCooldown: (retryAfterMinutes) =>
      t("surveysLaunch.toastCooldown", { minutes: retryAfterMinutes }),
    toastError: (detail) => t("surveysLaunch.toastError", { detail }),
    cadenceDialogTitle: (surveyLabel) =>
      t("surveysLaunch.cadenceDialogTitle", { survey: surveyLabel }),
    cadenceDialogBody: t("surveysLaunch.cadenceDialogBody"),
    cadenceOptionQuarterly: t("surveysLaunch.cadenceOptionQuarterly"),
    cadenceOptionMonthly: t("surveysLaunch.cadenceOptionMonthly"),
    cadenceOptionContinuous: t("surveysLaunch.cadenceOptionContinuous"),
    cadenceDialogCancel: t("surveysLaunch.cadenceDialogCancel"),
    cadenceDialogConfirm: t("surveysLaunch.cadenceDialogConfirm"),
    cadenceToastUpdated: t("surveysLaunch.cadenceToastUpdated"),
    cadenceToastError: (detail) => t("surveysLaunch.cadenceToastError", { detail }),
  };

  return (
    <main>
      <div className="fin-topchips">
        <span className="topbar-live">
          <span className="live-dot" />
          {t("topbarLive", { timestamp: lastTimestamp })}
        </span>
        {staleSourcesCount > 0 && (
          <a
            href="#tenant-health"
            className="topbar-live"
            style={{
              background: "var(--color-error-container)",
              color: "var(--color-on-error-container)",
              borderColor: "rgba(186,26,26,0.2)",
              textDecoration: "none",
              cursor: "pointer",
            }}
            title={t("topbarStaleSourceTitle")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>
              warning
            </span>
            {t("topbarStaleSource", { count: staleSourcesCount })}
          </a>
        )}
      </div>

      <div className="page-header">
        <div className="page-header-left">
          <div className="page-eyebrow">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              stacked_line_chart
            </span>
            {t("pageEyebrow", { count: tenantCount })}
          </div>
          <h1 className="page-title">
            {t("pageTitlePrefix")} <em>{t("pageTitleEm")}</em>
          </h1>
          <p className="page-subtitle">
            {t("pageSubtitle")}{" "}
            <span style={{ color: "var(--color-on-surface)", fontWeight: 500 }}>
              {periodOptions.find((o) => o.value === period)?.label} ·{" "}
              {filters.currency === "all" ? t("filters.currencyAll") : filters.currency} ·{" "}
              {filters.tenantId === "all" ? t("filters.tenantAll") : t("filters.tenantSelected")}.
            </span>
          </p>
        </div>
        {/* Action buttons. CSV export (#442) + Monthly PDF (#443) are
            both wired. */}
        <div className="page-header-actions">
          <Button
            type="button"
            variant="secondary"
            size="default"
            onClick={handleExportCsv}
            disabled={loading || summary === null}
            title={t("actionExportTitle")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden>
              download
            </span>
            {t("actionExport")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="default"
            onClick={handleGenerateMonthlyReport}
            disabled={reportBusy}
            aria-busy={reportBusy}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
              insights
            </span>
            {reportBusy ? t("actionMonthlyReportBusy") : t("actionMonthlyReport")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={handleBackfillReports}
            disabled={reportBusy}
            aria-busy={reportBusy}
            title={t("actionBackfill12MonthsTitle")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
              history
            </span>
            {t("actionBackfill12Months")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => setArchiveOpen((v) => !v)}
            aria-expanded={archiveOpen}
            aria-controls="finance-reports-archive"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
              folder_open
            </span>
            {archiveOpen ? t("actionArchiveHide") : t("actionArchiveShow")}
          </Button>
        </div>
      </div>

      {archiveOpen && (
        <section
          id="finance-reports-archive"
          aria-label={t("reports.archive.ariaLabel")}
          style={{
            marginBottom: 16,
            padding: 16,
            background: "var(--color-surface-container)",
            borderRadius: 8,
            border: "1px solid var(--color-outline-variant)",
          }}
        >
          <header
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--color-on-surface)" }}>
              {t("reports.archive.title")}
            </h2>
            <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>
              {t("reports.archive.subtitle")}
            </span>
          </header>
          <p
            role="note"
            style={{
              margin: "0 0 12px 0",
              padding: "8px 10px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--color-on-surface-variant)",
              background: "var(--color-surface-container-low, #f9f8f6)",
              borderLeft: "3px solid var(--color-primary)",
              borderRadius: 4,
            }}
          >
            <strong style={{ color: "var(--color-on-surface)" }}>
              {t("reports.archive.rgpdNoticeTitle")}
            </strong>{" "}
            — {t("reports.archive.rgpdNoticeBody")}
          </p>
          {reports.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--color-on-surface-variant)", margin: 0 }}>
              {t("reports.archive.empty")}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {reportsByYear.map(({ year, items }, groupIndex) => (
                <div key={year} style={{ marginTop: groupIndex === 0 ? 0 : 14 }}>
                  {/* Year band — a real <h3> (reachable by screen-reader
                      heading navigation) on the left, a decorative connecting
                      rule, and a report-count pill on the right. The h3 carries
                      a descriptive accessible name ("Année 2026 · N rapports")
                      while showing just the year visually. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "2px 0 6px",
                    }}
                  >
                    <h3
                      aria-label={t("reports.archive.yearGroupLabel", {
                        year,
                        count: items.length,
                      })}
                      style={{
                        margin: 0,
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        color: "var(--color-primary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {year}
                    </h3>
                    <span
                      aria-hidden
                      style={{
                        flex: 1,
                        height: 1,
                        background: "var(--color-outline-variant)",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--color-on-surface-variant)",
                        background: "var(--color-surface-container-low, #f9f8f6)",
                        padding: "2px 8px",
                        borderRadius: 999,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("reports.archive.yearCount", { count: items.length })}
                    </span>
                  </div>
                  {/* Months are indented under the year band to signal the
                      year → months hierarchy. */}
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, paddingLeft: 18 }}>
                    {items.map((r, idx) => (
                      <ReportArchiveRow
                        key={r.id}
                        report={r}
                        isLast={idx === items.length - 1}
                        reportBusy={reportBusy}
                        onRegenerate={requestRegenerate}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="finance-toolbar">
        <div className="segmented" role="radiogroup" aria-label={t("period.ariaLabel")}>
          {periodOptions.map((opt) => (
            // biome-ignore lint/a11y/useSemanticElements: pill-styled buttons in a radiogroup; native <input type="radio"> would defeat the styling + icon affordances. WCAG-compliant via role="radio" + aria-checked.
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={period === opt.value}
              className={period === opt.value ? "active" : ""}
              onClick={() => handlePeriodChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="finance-toolbar-right">
          <select
            className="form-select"
            aria-label={t("filters.currencyAria")}
            value={filters.currency}
            onChange={(e) => handleCurrencyChange(e.target.value as FinanceFilters["currency"])}
          >
            <option value="all">{t("filters.currencyAll")}</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="CHF">CHF</option>
          </select>
          <select
            className="form-select"
            aria-label={t("filters.tenantAria")}
            value={filters.tenantId}
            onChange={(e) => handleTenantChange(e.target.value)}
          >
            <option value="all">{t("filters.tenantAll")}</option>
            {mobilisation.perTenant.map((tenant) => (
              <option key={tenant.tenantId} value={tenant.tenantId}>
                {tenant.tenantName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {atRiskCount > 0 && (
        <a href="#tenant-health" className="hero-alert" style={{ textDecoration: "none" }}>
          <span className="material-symbols-outlined ha-icon">crisis_alert</span>
          <span className="ha-body">
            {t.rich("heroAlert.bodyRich", {
              count: atRiskCount,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </span>
          <span className="ha-cta">{t("heroAlert.cta")}</span>
        </a>
      )}

      <section className="hero" aria-labelledby="hero-lab">
        <div className="hero-block">
          <div className="hero-label" id="hero-lab">
            <span className="material-symbols-outlined">monitoring</span>
            {t("mobilisationHero.title")}
            <span
              className="material-symbols-outlined info-i"
              title={t("mobilisationHero.titleInfo")}
            >
              info
            </span>
          </div>
          <div className="hero-score">
            <span className={`hero-grade ${heroGradeClass(heroGrade)}`}>{heroGrade ?? "—"}</span>
            <span>
              <span className="hero-score-num">{heroScore}</span>
              <span className="hero-score-out">&nbsp;{t("mobilisationHero.outOf")}</span>
            </span>
          </div>
          <div className="hero-meta">
            <span className="delta-pill delta-pill--flat">
              <span className="material-symbols-outlined">remove</span>
              {t("mobilisationHero.deltaPlaceholder")}
            </span>
            <span className="kpi-foot">{t("mobilisationHero.periodLabel")}</span>
          </div>
          <p className="hero-foot">
            {t.rich("mobilisationHero.footnoteRich", {
              count: tenantCount,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </p>
        </div>
        <div className="hero-block">
          <div className="hero-label">
            <span className="material-symbols-outlined">tune</span>
            {t("formulaHero.title")}
          </div>
          <ol className="formula-list">
            {componentRows.map((row) => (
              <li key={row.label} className="formula-row">
                <span className="lab">{row.label}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${row.pct}%`, background: row.color }} />
                </span>
                <span className="pct">
                  <b>{row.pct}</b> · {row.weight}%
                </span>
              </li>
            ))}
          </ol>
          <p className="hero-foot">
            {t.rich("formulaHero.footnoteRich", {
              b: (chunks) => <b>{chunks}</b>,
            })}
          </p>
        </div>
        <GradeHistogram buckets={gradeBuckets} maxBucket={maxBucket} tenantCount={tenantCount} />
      </section>

      {/* ADR-035 rules A2/B12 — the KPI row staggers via the shared
          `.cascade` container (nth-child feeds --cascade-i 1-4), replacing
          the legacy `.reveal` nth-child utility so this surface speaks the
          standard motion grammar. The animation runs once per mount:
          period/filter changes swap values in place without remounting
          this tree, so the entrance never replays on refetch. */}
      <div className="kpi-grid cascade">
        <article className="kpi">
          <div className="kpi-head">
            <div className="kpi-label">{t("kpis.volume.label")}</div>
            <div
              className="kpi-icon"
              style={{
                background: "var(--color-primary-fixed)",
                color: "var(--color-on-primary-fixed-variant)",
              }}
            >
              <span className="material-symbols-outlined">savings</span>
            </div>
          </div>
          <div className="kpi-value">
            {volumeKpi.main}
            <span className="suffix">{volumeKpi.suffix}</span>
          </div>
          <div className="kpi-meta">
            <span className={`delta-pill delta-pill--${deltaPillVariant(volumeDelta)}`}>
              <span className="material-symbols-outlined">
                {deltaPillIcon(deltaPillVariant(volumeDelta))}
              </span>
              {volumeDelta >= 0 ? "+" : ""}
              {formatPercent(volumeDelta, 1)}%
            </span>
            <span className="kpi-foot">
              {t("kpisExtra.volumeFoot", { count: formatNumber(kpis.donorCount) })}
            </span>
          </div>
        </article>

        <article className="kpi">
          <div className="kpi-head">
            <div className="kpi-label">
              {t("kpis.revenue.label")}{" "}
              <span
                className="material-symbols-outlined info-i"
                title={t("kpisExtra.revenueInfoTitle")}
              >
                info
              </span>
            </div>
            <div
              className="kpi-icon"
              style={{
                background: "var(--color-tertiary-fixed)",
                color: "var(--color-on-tertiary-fixed-variant)",
              }}
            >
              <span className="material-symbols-outlined">request_quote</span>
            </div>
          </div>
          <div className="kpi-value">
            {revenueKpi.main}
            <span className="suffix">{revenueKpi.suffix}</span>
          </div>
          <div className="kpi-meta">
            <span className={`delta-pill delta-pill--${deltaPillVariant(revenueDelta)}`}>
              <span className="material-symbols-outlined">
                {deltaPillIcon(deltaPillVariant(revenueDelta))}
              </span>
              {revenueDelta >= 0 ? "+" : ""}
              {formatPercent(revenueDelta, 1)}%
            </span>
            <span className="kpi-foot">
              {t("kpisExtra.revenueFoot", { rate: formatPercent(takeRate, 2) })}
            </span>
          </div>
        </article>

        <article className="kpi">
          <div className="kpi-head">
            <div className="kpi-label">
              {t("kpis.recurring.label")}{" "}
              <span
                className="material-symbols-outlined info-i"
                title={t("kpisExtra.recurringInfoTitle")}
              >
                info
              </span>
            </div>
            <div
              className="kpi-icon"
              style={{
                background: "var(--color-secondary-fixed)",
                color: "var(--color-on-secondary-fixed-variant)",
              }}
            >
              <span className="material-symbols-outlined">autorenew</span>
            </div>
          </div>
          <div className="kpi-value">
            {recurringKpi.main}
            <span className="suffix">{t("kpisExtra.recurringSuffix")}</span>
          </div>
          <div className="kpi-meta">
            <span className="delta-pill delta-pill--flat">
              <span className="material-symbols-outlined">remove</span>—
            </span>
            <span className="kpi-foot">
              {t("kpisExtra.recurringFoot", { share: Math.round(recurringRatio) })}
            </span>
          </div>
        </article>

        <article className="kpi">
          <div className="kpi-head">
            <div className="kpi-label">
              {t("kpis.stripe.label")}{" "}
              <span
                className="material-symbols-outlined info-i"
                title={t("kpisExtra.stripeInfoTitle")}
              >
                info
              </span>
            </div>
            <div
              className="kpi-icon"
              style={{ background: "var(--color-indigo-light)", color: "var(--color-indigo-text)" }}
            >
              <span className="material-symbols-outlined">credit_card</span>
            </div>
          </div>
          <div className="kpi-value">
            {stripeKpi.main}
            {stripeKpi.suffix && <span className="suffix">{stripeKpi.suffix}</span>}
          </div>
          <div className="kpi-meta">
            <span className={`delta-pill delta-pill--${deltaPillVariant(stripeDelta, true)}`}>
              <span className="material-symbols-outlined">
                {deltaPillIcon(deltaPillVariant(stripeDelta, true))}
              </span>
              {stripeDelta >= 0 ? "+" : ""}
              {formatPercent(stripeDelta, 1)}%
            </span>
            <span className="kpi-foot">
              {t("kpisExtra.stripeFoot", { rate: formatPercent(stripeSharePercent, 2) })}
            </span>
          </div>
        </article>
      </div>

      <div className="section-head">
        <h2>{t("sections.timeline")}</h2>
        <span className="rule" />
        <span className="hint">{t("sectionHints.timeline")}</span>
      </div>
      <div className="fin-card">
        {!isEmpty ? (
          <VolumeRevenueChart
            data={summary.timeseries.map((p) => ({
              label: formatShortDate(p.date),
              volume: p.volumeCents / 100,
              revenue: p.platformFeeCents / 100,
            }))}
            volumeMax={Math.max(...summary.timeseries.map((p) => p.volumeCents / 100), 100)}
            labels={{
              ariaLabel: t("chartLabels.ariaLabel"),
              volumeLabel: t("chartLabels.volumeLabel"),
              revenueLabel: t("chartLabels.revenueLabel"),
              formatVolumeTick: (v) => `€${Math.round(v / 1000)}k`,
              formatRevenueTick: (v) => `€${Math.round(v)}`,
              formatVolume: (v) => formatCents(Math.round(v * 100), "EUR", false),
              formatRevenue: (v) => formatCents(Math.round(v * 100), "EUR", false),
            }}
          />
        ) : (
          <p style={{ color: "var(--color-on-surface-variant)" }}>{t("empty.title")}</p>
        )}
      </div>

      <div className="section-head">
        <h2>{t("sections.risk")}</h2>
        <span className="rule" />
        <span className="hint">{t("sectionHints.risk")}</span>
      </div>
      <div className="risk-grid">
        <div className="risk-item">
          <div className="rl">
            {t("riskExtra.concentrationLabelWithHhi")}{" "}
            <span
              className="material-symbols-outlined info-i"
              title={t("riskExtra.concentrationInfoTitle")}
            >
              info
            </span>
          </div>
          <div className="rv">{hhi.toFixed(2)}</div>
          <div className="rs">
            {t("riskExtra.concentrationTopTenant", {
              pct:
                topTenants[0] && kpis.volumeCents > 0
                  ? formatPercent((topTenants[0].volumeCents / kpis.volumeCents) * 100, 1)
                  : "0",
            })}
          </div>
          <span
            className={`risk-badge risk-badge--${hhiVariant === "alert" ? "watch" : hhiVariant}`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
              {hhiVariant === "ok" ? "check_circle" : "warning"}
            </span>
            {hhiVariant === "ok"
              ? t("risk.badges.okConcentration")
              : hhiVariant === "watch"
                ? t("riskExtra.concentrationBadgeWatch")
                : t("riskExtra.concentrationBadgeAlert")}
          </span>
        </div>
        <div className="risk-item">
          <div className="rl">
            {t("risk.activeTenants.label")}{" "}
            <span
              className="material-symbols-outlined info-i"
              title={t("riskExtra.activeTenantsInfoTitle")}
            >
              info
            </span>
          </div>
          <div className="rv">
            {kpis.activeTenantsCount}{" "}
            <span
              style={{ fontSize: "var(--text-base)", color: "var(--color-on-surface-variant)" }}
            >
              / {tenantCount}
            </span>
          </div>
          <div className="rs">
            {t("riskExtra.activeTenantsSecondary", {
              active:
                tenantCount > 0
                  ? formatPercent((kpis.activeTenantsCount / tenantCount) * 100, 0)
                  : "0",
              dormant: tenantCount - kpis.activeTenantsCount,
            })}
          </div>
        </div>
        <div className="risk-item">
          <div className="rl">
            {t("riskExtra.failureLabelFull")}{" "}
            <span
              className="material-symbols-outlined info-i"
              title={t("riskExtra.failureInfoTitle")}
            >
              info
            </span>
          </div>
          <div className="rv">{formatPercent(failureRate, 1)} %</div>
          <div className="rs">{t("riskExtra.failureFootnote")}</div>
        </div>
      </div>

      <div className="section-head" id="tenant-health">
        <h2>{t("sections.health")}</h2>
        <span className="rule" />
        <span className="hint">{t("health.sectionHint")}</span>
      </div>
      <div className="fin-card">
        <div className="th-grid">
          <div className="th-pmf">
            <div className="th-label">
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 16, color: "var(--color-primary)" }}
              >
                psychology
              </span>
              {t("pmfExtra.titleFull")}
              {pmfSurvey && (
                <span className={`fresh-pip fresh-pip--${pmfFreshness}`}>
                  <span className="material-symbols-outlined">schedule</span>
                  {pmfFreshness === "ok"
                    ? t("freshness.fresh")
                    : pmfFreshness === "soon"
                      ? t("freshness.soon")
                      : t("freshness.stale")}
                </span>
              )}
            </div>
            {pmfPercent !== null ? (
              <>
                <div className="pmf-headline">
                  <span className="pmf-big">
                    {Math.round(pmfPercent)}
                    <span className="pmf-unit">%</span>
                  </span>
                  <span className="pmf-threshold">
                    {t.rich("pmfExtra.headlineRich", {
                      b: (chunks) => <b>{chunks}</b>,
                    })}
                  </span>
                </div>
                <div className="sentiment-bar-wrap">
                  <div
                    className="sentiment-bar"
                    role="img"
                    aria-label={t("pmfExtra.ariaLabel", { pct: Math.round(pmfPercent) })}
                  >
                    <div className="sentiment-seg seg-very" style={{ flex: pmfPercent }}>
                      {Math.round(pmfPercent)}%
                    </div>
                    <div
                      className="sentiment-seg seg-somewhat"
                      style={{ flex: Math.max(0, 80 - pmfPercent) }}
                    >
                      {t("pmfExtra.segmentSomewhat")}
                    </div>
                    <div className="sentiment-seg seg-not" style={{ flex: 20 }}>
                      {t("pmfExtra.segmentNot")}
                    </div>
                  </div>
                  <div className="pmf-marker" aria-hidden="true">
                    <span className="line" />
                    <span className="tag">{t("pmfExtra.markerLabelShort")}</span>
                  </div>
                </div>
                <div className="sentiment-legend">
                  <span className="li">
                    <span className="sw" style={{ background: "var(--color-primary)" }} />
                    {t.rich("pmfExtra.legendVeryRich", {
                      b: (chunks) => <b>{chunks}</b>,
                    })}
                  </span>
                  <span className="li">
                    <span
                      className="sw"
                      style={{ background: "var(--color-tertiary-fixed-dim)" }}
                    />{" "}
                    {t("pmf.legendSomewhat")}
                  </span>
                  <span className="li">
                    <span
                      className="sw"
                      style={{ background: "var(--color-surface-container-highest)" }}
                    />{" "}
                    {t("pmf.legendNot")}
                  </span>
                </div>
              </>
            ) : (
              <p style={{ color: "var(--color-on-surface-variant)", marginTop: 8 }}>
                {t("pmfExtra.noResponsesYet")}
              </p>
            )}
          </div>
          <div className="th-side">
            <div className="sat-mini">
              <div className="l">
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 14, color: "var(--color-primary)" }}
                >
                  thumb_up
                </span>
                {t("health.npsShort")}
                {npsSurvey && (
                  <span className={`fresh-pip fresh-pip--${npsFreshness}`}>
                    <span className="material-symbols-outlined">schedule</span>
                    {npsFreshness === "ok" ? t("freshness.fresh") : t("freshness.stale")}
                  </span>
                )}
              </div>
              <div className="v">
                {npsSurvey?.npsScore !== null && npsSurvey?.npsScore !== undefined
                  ? Math.round(npsSurvey.npsScore)
                  : "—"}
                <small>{t("health.npsUnit")}</small>
              </div>
              <span className="legacy">{t("health.npsHistoric")}</span>
            </div>
            <div className="sat-mini">
              <div className="l">
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 14, color: "var(--color-primary)" }}
                >
                  sentiment_satisfied
                </span>
                {t("health.csatLabelFull")}
                {csatSurvey && (
                  <span className={`fresh-pip fresh-pip--${csatFreshness}`}>
                    <span className="material-symbols-outlined">schedule</span>
                    {csatFreshness === "ok" ? t("freshness.fresh") : t("freshness.stale")}
                  </span>
                )}
              </div>
              <div className="v">
                {csatSurvey?.csatScore !== null && csatSurvey?.csatScore !== undefined
                  ? csatSurvey.csatScore.toFixed(1)
                  : "—"}
                <small>{t("health.csatUnit")}</small>
              </div>
            </div>
            {atRiskCount > 0 && (
              <div className="sat-mini" style={{ background: "var(--color-error-container)" }}>
                <div className="l" style={{ color: "var(--color-on-error-container)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                    crisis_alert
                  </span>
                  {t("health.recontactLabel")}
                </div>
                <div className="v" style={{ color: "var(--color-on-error-container)" }}>
                  {atRiskCount}
                  <small style={{ color: "var(--color-on-error-container)" }}>
                    {t("health.recontactUnit")}
                  </small>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {summary.surveys.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SurveyLaunchCard
            surveys={summary.surveys}
            labels={surveyLaunchLabels}
            onLaunch={handleLaunchSurvey}
            onSchedule={handleScheduleSurvey}
          />
        </div>
      )}

      <div className="section-head">
        <h2>{t("sections.tenants")}</h2>
        <span className="rule" />
        <span className="hint">{t("sectionHints.tenants")}</span>
      </div>
      <div className="two-col">
        <div className="fin-card">
          <div className="fin-card-header">
            <div>
              <div className="fin-card-title">{t("topTenantsCard.title")}</div>
              <div className="fin-card-subtitle">{t("topTenantsCard.subtitle")}</div>
            </div>
          </div>
          {topTenants.length > 0 ? (
            <>
              <div className="tenant-row head">
                <span />
                <span>{t("topTenantsCard.headerName")}</span>
                <span style={{ textAlign: "right" }}>{t("topTenantsCard.headerScore")}</span>
                <span style={{ textAlign: "right" }}>{t("topTenantsCard.headerVolume")}</span>
              </div>
              {topTenants.map((tenant, idx) => {
                const sharePct =
                  kpis.volumeCents > 0 ? (tenant.volumeCents / kpis.volumeCents) * 100 : 0;
                const mob = mobilisation.perTenant.find((m) => m.tenantId === tenant.tenantId);
                return (
                  <div key={tenant.tenantId} className="tenant-row">
                    <span className="tenant-rank">{String(idx + 1).padStart(2, "0")}</span>
                    <div style={{ minWidth: 0 }}>
                      <a href={`/admin/tenants/${tenant.tenantId}`} className="tenant-name">
                        {tenant.tenantName}
                      </a>
                      <div className="tenant-meta">
                        <div className="tenant-track">
                          <div className="tenant-fill" style={{ width: `${sharePct}%` }} />
                        </div>
                        <span className="tenant-share">{formatPercent(sharePct, 1)} %</span>
                      </div>
                    </div>
                    <span style={{ textAlign: "right" }}>
                      <span className={`grade-chip ${gradeClass(mob?.grade ?? null)}`}>
                        <span className="ltr">{mob?.grade ?? "—"}</span>
                        {mob?.score != null && <span className="n">{Math.round(mob.score)}</span>}
                      </span>
                    </span>
                    <span className="tenant-amount">
                      {formatCents(tenant.volumeCents, "EUR", false)}
                      <small>
                        {t("topTenantsCard.donationsCountSuffix", {
                          count: tenant.donationCount,
                        })}
                      </small>
                    </span>
                  </div>
                );
              })}
            </>
          ) : (
            <p style={{ color: "var(--color-on-surface-variant)" }}>{t("topTenantsCard.empty")}</p>
          )}
        </div>
        <div className="stack">
          <div className="fin-card">
            <div className="fin-card-header">
              <div>
                <div className="fin-card-title">{t("sections.refunds")}</div>
                <div className="fin-card-subtitle">{t("refundCard.subtitle")}</div>
              </div>
            </div>
            <div className="gauge-val">
              {formatPercent(refundPct, 2)}
              <span className="unit">%</span>
            </div>
            <div className="gauge-track">
              <div className="gauge-cursor" style={{ left: `calc(${refundCursorPct}% - 1.5px)` }} />
            </div>
            <div className="gauge-ticks">
              <span className="t" style={{ left: "0%" }}>
                {t("refundCard.tick0")}
              </span>
              <span className="t" style={{ left: "12.5%" }}>
                {t("refundCard.tick1")}
              </span>
              <span className="t" style={{ left: "62.5%" }}>
                {t("refundCard.tick2")}
              </span>
              <span className="t" style={{ left: "100%" }}>
                {t("refundCard.tick3")}
              </span>
            </div>
            <p className="kpi-foot" style={{ marginTop: "var(--space-3)" }}>
              {t("refundCard.amountSuffix", {
                amount: formatCents(kpis.refundedVolumeCents, "EUR", false),
              })}
            </p>
          </div>
          <div className="fin-card">
            <div className="fin-card-header">
              <div>
                <div className="fin-card-title">{t("sections.currencies")}</div>
                <div className="fin-card-subtitle">{t("currenciesCard.subtitle")}</div>
              </div>
            </div>
            <div className="donut-wrap">
              <CurrencyDonutSvg
                slices={summary.perCurrency.map((c, idx) => ({
                  currency: c.currency,
                  pct: totalCurrencyVolume > 0 ? (c.volumeCents / totalCurrencyVolume) * 100 : 0,
                  color:
                    ["var(--color-primary)", "var(--color-tertiary)", "var(--color-indigo)"][
                      idx % 3
                    ] ?? "var(--color-primary)",
                }))}
              />
              <div className="ccy-legend">
                {summary.perCurrency.map((c, idx) => {
                  const sharePct =
                    totalCurrencyVolume > 0 ? (c.volumeCents / totalCurrencyVolume) * 100 : 0;
                  return (
                    <div key={c.currency} className="ccy-row">
                      <span
                        className="sw"
                        style={{
                          background:
                            [
                              "var(--color-primary)",
                              "var(--color-tertiary)",
                              "var(--color-indigo)",
                            ][idx % 3] ?? "var(--color-primary)",
                        }}
                      />
                      <span className="c">{c.currency}</span>
                      <span className="a">{formatCents(c.volumeCents, "EUR", false)}</span>
                      <span className="s">{formatPercent(sharePct, 1)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="audit-footer">
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
          fingerprint
        </span>
        {t.rich("viewLoadedAt", {
          timestamp: lastTimestamp,
          code: (chunks) => <code>{chunks}</code>,
        })}
        {/* Discreet operator action — used in rare cases (e.g. just
            after an out-of-band SQL refresh). Server-side rate-limited
            to 5/min, audited. Issue #449. */}
        <button
          type="button"
          onClick={handleFlushCache}
          disabled={flushing}
          style={{
            marginLeft: "var(--space-3)",
            appearance: "none",
            background: "transparent",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "var(--color-on-surface-variant)",
            textDecoration: "underline",
            cursor: flushing ? "wait" : "pointer",
          }}
        >
          {flushing ? t("cacheFlush.busy") : t("cacheFlush.cta")}
        </button>
      </div>

      {loading && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            padding: "8px 16px",
            background: "var(--color-inverse-surface)",
            color: "var(--color-inverse-on-surface)",
            borderRadius: 999,
            fontSize: 13,
          }}
        >
          {t("loading")}
        </div>
      )}

      <AlertDialog
        open={reportToRegenerate !== null}
        onOpenChange={(open) => {
          if (!open) setReportToRegenerate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reportToRegenerate
                ? t("reports.archive.regenerateDialogTitle", { month: reportToRegenerate.month })
                : null}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("reports.archive.regenerateDialogBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reportBusy}>
              {t("reports.archive.regenerateDialogCancel")}
            </AlertDialogCancel>
            <Button
              type="button"
              variant="primary"
              onClick={() => void confirmRegenerate()}
              disabled={reportBusy}
            >
              {reportBusy
                ? t("reports.archive.regenerateDialogConfirmBusy")
                : t("reports.archive.regenerateDialogConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

interface ReportArchiveRowProps {
  report: MonthlyReport;
  /** Last row of its year group — drops the bottom border (the next year
      band already provides the separation, avoiding a doubled divider). */
  isLast: boolean;
  reportBusy: boolean;
  onRegenerate: (report: MonthlyReport) => void;
}

function ReportArchiveRow({ report: r, isLast, reportBusy, onRegenerate }: ReportArchiveRowProps) {
  const t = useTranslations("admin.finance");
  const locale = useLocale();

  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "120px 100px 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: "8px 0",
        borderBottom: isLast ? "none" : "1px solid var(--color-outline-variant)",
        fontSize: 13,
      }}
    >
      {/* The year lives in the band above, so each row shows only the month
          name; the full "Mai 2026" stays available as a hover title. */}
      <strong style={{ color: "var(--color-on-surface)" }} title={formatMonthYear(r.month, locale)}>
        {formatMonthName(r.month, locale)}
      </strong>
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color:
            r.status === "ready"
              ? "var(--color-primary)"
              : r.status === "failed"
                ? "var(--color-error)"
                : "var(--color-on-surface-variant)",
        }}
      >
        {r.status === "ready"
          ? t("reports.archive.statusReady")
          : r.status === "pending"
            ? t("reports.archive.statusPending")
            : t("reports.archive.statusFailed")}
      </span>
      <span
        style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}
        title={r.failureReason ?? undefined}
      >
        {r.readyAt
          ? t("reports.archive.generatedAt", {
              date: new Date(r.readyAt).toLocaleString(locale, {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
            })
          : r.status === "failed"
            ? (r.failureReason ?? t("reports.archive.errorPlaceholder"))
            : "—"}
      </span>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {r.status === "ready" && r.pdfUrl ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const api = createClientApiClient();
              window.location.assign(api.resolveBrowserUrl(r.pdfUrl ?? ""));
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden>
              download
            </span>
            {t("reports.archive.downloadPdf")}
          </Button>
        ) : null}
        {r.status !== "pending" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRegenerate(r)}
            disabled={reportBusy}
            title={t("reports.archive.regenerateTitle")}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden>
              refresh
            </span>
            {t("reports.archive.regenerate")}
          </Button>
        )}
      </div>
    </li>
  );
}

function computeFreshness(
  lastCollectedAt: string | null,
  cadence: "quarterly" | "continuous",
): "ok" | "soon" | "stale" {
  if (!lastCollectedAt) return "stale";
  const ageDays = (Date.now() - new Date(lastCollectedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (cadence === "continuous") {
    if (ageDays < 30) return "ok";
    if (ageDays < 90) return "soon";
    return "stale";
  }
  if (ageDays < 90) return "ok";
  if (ageDays < 180) return "soon";
  return "stale";
}

interface CurrencyDonutSvgProps {
  slices: Array<{ currency: string; pct: number; color: string }>;
}

function CurrencyDonutSvg({ slices }: CurrencyDonutSvgProps) {
  const radius = 50;
  const strokeWidth = 18;
  const circumference = 2 * Math.PI * radius;
  let cumulativeOffset = 0;
  const center = 65;
  return (
    <svg className="donut" viewBox="0 0 130 130" aria-hidden="true">
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="var(--color-surface-container-high)"
        strokeWidth={strokeWidth}
      />
      {slices.map((slice) => {
        const dash = (slice.pct / 100) * circumference;
        const offset = cumulativeOffset;
        cumulativeOffset -= dash;
        return (
          <circle
            key={slice.currency}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={slice.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        );
      })}
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────
// GradeHistogram + whack-a-mole easter egg
//
// Triple-click the "Répartition · N tenants" label within 600 ms to
// activate a 30-second whack-a-mole round. One of the five bars shoots
// up (the "mole"), the others stay flat. Click the mole → +1, mole
// rotates immediately. Mole also rotates every ~1.2 s on its own. When
// the timer hits 0, score lingers for 4 s then the widget silently
// returns to the real grade distribution.
//
// Deliberate easter-egg posture: no UI affordance hints at it (no
// pointer cursor on the label, no tooltip, no a11y announcement). The
// real distribution KPI is the load-bearing surface; the game is fun
// for whoever discovers it. Stays inside this file because it's a tiny
// self-contained component that only this page hosts.
// ──────────────────────────────────────────────────────────────────────

interface GradeHistogramProps {
  buckets: Array<{ key: string; count: number; color: string }>;
  maxBucket: number;
  tenantCount: number;
}

const TRIPLE_CLICK_WINDOW_MS = 600;
const GAME_DURATION_SECONDS = 30;
const MOLE_ROTATION_MS = 1200;
const GAME_OVER_LINGER_MS = 4000;

function GradeHistogram({ buckets, maxBucket, tenantCount }: GradeHistogramProps) {
  const t = useTranslations("admin.finance");
  const [gameActive, setGameActive] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [moleIndex, setMoleIndex] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_SECONDS);
  const clickTimesRef = useRef<number[]>([]);

  const handleLabelClick = useCallback(() => {
    if (gameActive) return;
    const now = Date.now();
    clickTimesRef.current = [
      ...clickTimesRef.current.filter((t) => now - t < TRIPLE_CLICK_WINDOW_MS),
      now,
    ];
    if (clickTimesRef.current.length >= 3) {
      clickTimesRef.current = [];
      setGameActive(true);
      setGameOver(false);
      setScore(0);
      setTimeLeft(GAME_DURATION_SECONDS);
      setMoleIndex(Math.floor(Math.random() * buckets.length));
    }
  }, [gameActive, buckets.length]);

  // Countdown.
  useEffect(() => {
    if (!gameActive) return;
    const interval = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          setGameActive(false);
          setGameOver(true);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [gameActive]);

  // Mole rotation — pick a different bar every ~1.2 s.
  useEffect(() => {
    if (!gameActive) return;
    const interval = setInterval(() => {
      setMoleIndex((current) => {
        const next = Math.floor(Math.random() * buckets.length);
        return current !== null && next === current ? (next + 1) % buckets.length : next;
      });
    }, MOLE_ROTATION_MS);
    return () => clearInterval(interval);
  }, [gameActive, buckets.length]);

  // After game-over, return to real distribution after the linger.
  useEffect(() => {
    if (!gameOver) return;
    const t = setTimeout(() => setGameOver(false), GAME_OVER_LINGER_MS);
    return () => clearTimeout(t);
  }, [gameOver]);

  const handleBarClick = useCallback(
    (idx: number) => {
      if (!gameActive || moleIndex === null) return;
      if (idx === moleIndex) {
        setScore((s) => s + 1);
        setMoleIndex(Math.floor(Math.random() * buckets.length));
      }
    },
    [gameActive, moleIndex, buckets.length],
  );

  return (
    <div className="hero-block">
      <button
        type="button"
        className="hero-label"
        onClick={handleLabelClick}
        // Reset to <button> defaults; mockup styles .hero-label as a flex row
        // and we keep it a label visually. The native button is the safe a11y
        // wrapper for the click handler without surfacing the easter egg.
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "inherit",
          cursor: "default",
          textAlign: "left",
          width: "auto",
        }}
      >
        <span className="material-symbols-outlined">bar_chart</span>
        {t("histogramExtra.label", { count: tenantCount })}
      </button>
      <div
        className="hero-hist"
        role="img"
        aria-label={buckets
          .map((b) => t("histogramExtra.barAriaItem", { count: b.count, grade: b.key }))
          .join(", ")}
      >
        {buckets.map((b, idx) => {
          const isMole = gameActive && idx === moleIndex;
          const heightPct = gameActive ? (isMole ? 95 : 8) : (b.count / maxBucket) * 95 + 5;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: hidden easter-egg surface, mouse-only by design — a button would expose the game via keyboard/SR navigation and break the easter-egg posture
            // biome-ignore lint/a11y/useKeyWithClickEvents: same — keyboard handler would surface the easter egg
            <div
              key={b.key}
              className="hist-col"
              onClick={() => handleBarClick(idx)}
              style={{ cursor: gameActive ? "pointer" : "default" }}
            >
              <span className="cnt">{gameActive ? "" : b.count}</span>
              <div
                className="bar"
                style={{
                  height: `${heightPct}%`,
                  background: b.color,
                  transition: "height 0.3s ease",
                }}
              />
              <span className="lab">{b.key}</span>
            </div>
          );
        })}
      </div>
      <p className="hero-foot" style={{ marginTop: "var(--space-5)" }}>
        {gameActive
          ? t("histogramExtra.gameScore", { score, timeLeft })
          : gameOver
            ? t("histogramExtra.gameOver", { score })
            : t("histogramExtra.footnoteFull", { count: tenantCount })}
      </p>
    </div>
  );
}
