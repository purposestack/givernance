"use client";

/**
 * Super-admin finance dashboard — direct port of the Claude Design mockup
 * (docs/design/admin/dashboard.html) into JSX with dynamic data slots.
 *
 * First-pass strategy: keep the mockup markup verbatim (same class names,
 * same DOM structure) for guaranteed visual parity. Componentization +
 * i18n refactor will follow in a separate PR once visual fidelity is
 * validated. FR copy lifted from the mockup; EN translation is a follow-up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast, VolumeRevenueChart } from "@/components/admin/finance";
import { Button } from "@/components/ui/button";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { FinancePeriod, FinanceSummary, MonthlyReport } from "@/models/superadmin-finance";
import { SuperAdminFinanceService } from "@/services/SuperAdminFinanceService";

import "./finance-mockup.css";

interface FinanceDashboardProps {
  initialSummary: FinanceSummary | null;
  initialError: boolean;
}

const PERIOD_OPTIONS: Array<{ value: FinancePeriod; label: string }> = [
  { value: "today", label: "Aujourd'hui" },
  { value: "7d", label: "7 j" },
  { value: "30d", label: "30 j" },
  { value: "90d", label: "90 j" },
  { value: "ytd", label: "YTD" },
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

  const handlePeriodChange = useCallback((next: FinancePeriod) => setPeriod(next), []);

  const handleFlushCache = useCallback(async () => {
    if (flushing) return;
    setFlushing(true);
    try {
      const api = createClientApiClient();
      const result = await SuperAdminFinanceService.flushCache(api);
      toast.success(`Cache vidé · ${result.keysDeleted} entrée(s) supprimée(s)`);
      // Re-fetch with current period/filters to populate the freshly-
      // flushed cache and update the view.
      const data = await SuperAdminFinanceService.fetchSummary(api, {
        period,
        currency: filters.currency === "all" ? undefined : filters.currency,
        tenantId: filters.tenantId === "all" ? undefined : filters.tenantId,
      });
      setSummary(data);
    } catch {
      toast.error("Le flush a échoué — réessayez dans une minute.");
    } finally {
      setFlushing(false);
    }
  }, [flushing, period, filters.currency, filters.tenantId]);
  const handleCurrencyChange = useCallback(
    (next: FinanceFilters["currency"]) => setFilters((f) => ({ ...f, currency: next })),
    [],
  );
  const handleTenantChange = useCallback(
    (next: FinanceFilters["tenantId"]) => setFilters((f) => ({ ...f, tenantId: next })),
    [],
  );

  // ─── Monthly PDF report (issue #443) ──────────────────────────────────────
  // The button is on the page header. Click → POST → poll the row by id
  // every 2s until `ready` (or `failed`), then trigger a same-tab
  // navigation to the streamed PDF URL.
  const [reportBusy, setReportBusy] = useState(false);
  const [reportMessage, setReportMessage] = useState<{
    tone: "info" | "error";
    text: string;
  } | null>(null);
  const [reports, setReports] = useState<MonthlyReport[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);

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

  const handleBackfillReports = useCallback(async () => {
    if (reportBusy) return;
    setReportBusy(true);
    setReportMessage({ tone: "info", text: "Backfill des 12 derniers mois en cours…" });
    const api = createClientApiClient();
    try {
      const result = await SuperAdminFinanceService.backfillReports(api);
      setReportMessage({
        tone: "info",
        text: `Backfill terminé — ${result.enqueued.length} nouveau(x) rapport(s) en file, ${result.skipped.length} déjà présent(s).`,
      });
      void refreshReports();
    } catch (err) {
      setReportMessage({
        tone: "error",
        text: err instanceof Error ? `Erreur backfill : ${err.message}` : "Erreur backfill.",
      });
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, refreshReports]);

  const handleGenerateMonthlyReport = useCallback(async () => {
    if (reportBusy) return;
    setReportBusy(true);
    setReportMessage({ tone: "info", text: "Génération en cours…" });
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
        setReportMessage({ tone: "info", text: `Rapport ${report.month} prêt — téléchargement…` });
        window.location.assign(absoluteUrl);
        void refreshReports();
      } else if (report.status === "failed") {
        setReportMessage({
          tone: "error",
          text: report.failureReason
            ? `Échec : ${report.failureReason}`
            : "Échec de la génération du rapport.",
        });
      } else {
        setReportMessage({
          tone: "error",
          text: "Rapport encore en attente — réessaie dans quelques minutes.",
        });
      }
    } catch (err) {
      setReportMessage({
        tone: "error",
        text:
          err instanceof Error
            ? `Erreur : ${err.message}`
            : "Erreur lors de la génération du rapport.",
      });
    } finally {
      setReportBusy(false);
    }
  }, [reportBusy, refreshReports]);

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
          Finance <em>plateforme</em>
        </h1>
        <div role="alert" style={{ padding: 24, color: "var(--color-error)" }}>
          Impossible de charger le résumé. Vérifie les logs API et réessaie.
        </div>
      </main>
    );
  }

  if (!summary) {
    return (
      <main>
        <h1 className="page-title">
          Finance <em>plateforme</em>
        </h1>
        <p style={{ color: "var(--color-on-surface-variant)" }}>Chargement…</p>
      </main>
    );
  }

  const { kpis, mobilisation } = summary;
  const isEmpty = kpis.volumeCents === 0 && summary.perTenant.length === 0;

  const heroGrade = mobilisation.platformGrade;
  const heroScore = Math.round(mobilisation.platformScore ?? 0);
  const componentRows: Array<{ label: string; pct: number; weight: number; color: string }> = [
    {
      label: "Activation",
      pct: Math.round(mobilisation.components.activation),
      weight: 25,
      color: "var(--color-primary)",
    },
    {
      label: "Récurrence",
      pct: Math.round(mobilisation.components.recurrence),
      weight: 25,
      color: "var(--color-primary-fixed-dim)",
    },
    {
      label: "Échelle",
      pct: Math.round(mobilisation.components.scale),
      weight: 20,
      color: "var(--color-secondary)",
    },
    {
      label: "Croissance",
      pct: Math.round(mobilisation.components.growth),
      weight: 20,
      color: "var(--color-tertiary)",
    },
    {
      label: "Diversité",
      pct: Math.round(mobilisation.components.diversity),
      weight: 10,
      color: "var(--color-indigo)",
    },
  ];

  const gradeBuckets: Array<{ key: string; count: number; color: string }> = (() => {
    const counts: Record<string, number> = { "A+": 0, A: 0, B: 0, C: 0, D: 0 };
    for (const t of mobilisation.perTenant) {
      if (t.grade && counts[t.grade] !== undefined) {
        counts[t.grade] = (counts[t.grade] ?? 0) + 1;
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
    (t) => t.grade === "D" || (t.grade === "C" && (t.score ?? 100) < 50),
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

  return (
    <main>
      <div className="fin-topchips">
        <span className="topbar-live">
          <span className="live-dot" />
          Transactions à jour · {lastTimestamp}
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
            title="Une source de données est périmée — cliquer pour aller voir."
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>
              warning
            </span>
            {staleSourcesCount} source{staleSourcesCount > 1 ? "s" : ""} périmée
            {staleSourcesCount > 1 ? "s" : ""}
          </a>
        )}
      </div>

      <div className="page-header">
        <div className="page-header-left">
          <div className="page-eyebrow">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              stacked_line_chart
            </span>
            Vue plateforme · {tenantCount} tenants
          </div>
          <h1 className="page-title">
            Finance <em>plateforme</em>
          </h1>
          <p className="page-subtitle">
            Volume, revenu Givernance, satisfaction et santé du portefeuille de tenants.{" "}
            <span style={{ color: "var(--color-on-surface)", fontWeight: 500 }}>
              {PERIOD_OPTIONS.find((o) => o.value === period)?.label} ·{" "}
              {filters.currency === "all" ? "toutes devises (éq. EUR)" : filters.currency} ·{" "}
              {filters.tenantId === "all" ? "tous tenants" : "tenant sélectionné"}.
            </span>
          </p>
        </div>
        {/* Action buttons. CSV export (#442) is still not wired —
            keep that one hidden per feedback_no_anticipatory_ui until
            the backend lands. The "Rapport mensuel" PDF (#443) is
            wired below. */}
        <div className="page-header-actions">
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
            {reportBusy ? "Génération…" : "Rapport mensuel"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={handleBackfillReports}
            disabled={reportBusy}
            aria-busy={reportBusy}
            title="Génère les rapports manquants des 12 derniers mois (idempotent)."
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
              history
            </span>
            Backfill 12 mois
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
            {archiveOpen ? "Masquer l'archive" : "Voir l'archive"}
          </Button>
          {reportMessage && (
            <p
              role={reportMessage.tone === "error" ? "alert" : "status"}
              style={{
                marginTop: 8,
                fontSize: 12,
                color:
                  reportMessage.tone === "error"
                    ? "var(--color-error)"
                    : "var(--color-on-surface-variant)",
              }}
            >
              {reportMessage.text}
            </p>
          )}
        </div>
      </div>

      {archiveOpen && (
        <section
          id="finance-reports-archive"
          aria-label="Archive des rapports mensuels"
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
              Archive · derniers rapports
            </h2>
            <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>
              Un rapport par mois · le plus récent en premier
            </span>
          </header>
          {reports.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--color-on-surface-variant)", margin: 0 }}>
              Aucun rapport pour l'instant. Clique « Rapport mensuel » ou « Backfill 12 mois ».
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {reports.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px 100px 1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "8px 0",
                    borderBottom: "1px solid var(--color-outline-variant)",
                    fontSize: 13,
                  }}
                >
                  <strong style={{ color: "var(--color-on-surface)" }}>{r.month}</strong>
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
                    {r.status === "ready" ? "Prêt" : r.status === "pending" ? "En cours…" : "Échec"}
                  </span>
                  <span
                    style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}
                    title={r.failureReason ?? undefined}
                  >
                    {r.readyAt
                      ? `Généré le ${new Date(r.readyAt).toLocaleString("fr-FR", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : r.status === "failed"
                        ? (r.failureReason ?? "Erreur")
                        : "—"}
                  </span>
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
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 14 }}
                        aria-hidden
                      >
                        download
                      </span>
                      PDF
                    </Button>
                  ) : (
                    <span aria-hidden style={{ width: 80 }} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="finance-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Période">
          {PERIOD_OPTIONS.map((opt) => (
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
            aria-label="Devise"
            value={filters.currency}
            onChange={(e) => handleCurrencyChange(e.target.value as FinanceFilters["currency"])}
          >
            <option value="all">Toutes devises (éq. EUR)</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="CHF">CHF</option>
          </select>
          <select
            className="form-select"
            aria-label="Tenant"
            value={filters.tenantId}
            onChange={(e) => handleTenantChange(e.target.value)}
          >
            <option value="all">Tous les tenants</option>
            {mobilisation.perTenant.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {atRiskCount > 0 && (
        <a href="#tenant-health" className="hero-alert" style={{ textDecoration: "none" }}>
          <span className="material-symbols-outlined ha-icon">crisis_alert</span>
          <span className="ha-body">
            <b>
              {atRiskCount} tenant{atRiskCount > 1 ? "s" : ""} en alerte
            </b>{" "}
            — détracteurs croisés avec un signal de churn. À contacter cette semaine.
          </span>
          <span className="ha-cta">Voir la liste →</span>
        </a>
      )}

      <section className="hero" aria-labelledby="hero-lab">
        <div className="hero-block">
          <div className="hero-label" id="hero-lab">
            <span className="material-symbols-outlined">monitoring</span>
            Score de Mobilisation
            <span
              className="material-symbols-outlined info-i"
              title="Indicateur de santé du fundraising — pas un score d'impact bénéficiaire."
            >
              info
            </span>
          </div>
          <div className="hero-score">
            <span className={`hero-grade ${heroGradeClass(heroGrade)}`}>{heroGrade ?? "—"}</span>
            <span>
              <span className="hero-score-num">{heroScore}</span>
              <span className="hero-score-out">&nbsp;/ 100</span>
            </span>
          </div>
          <div className="hero-meta">
            <span className="delta-pill delta-pill--flat">
              <span className="material-symbols-outlined">remove</span>—
            </span>
            <span className="kpi-foot">vs période préc. · moy. pondérée volume</span>
          </div>
          <p className="hero-foot">
            Santé du fundraising agrégée sur <b>{tenantCount} tenants</b>. Un score A en
            médico-social ≠ un A en culture — privilégier le <b>delta</b> à l'absolu.
          </p>
        </div>
        <div className="hero-block">
          <div className="hero-label">
            <span className="material-symbols-outlined">tune</span>
            Composantes · moyenne plateforme
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
            La décomposition est affichée par <b>transparence</b>. Chaque composante est plafonnée à
            100 avant pondération.
          </p>
        </div>
        <GradeHistogram buckets={gradeBuckets} maxBucket={maxBucket} tenantCount={tenantCount} />
      </section>

      <div className="kpi-grid">
        <article className="kpi reveal">
          <div className="kpi-head">
            <div className="kpi-label">Volume des dons</div>
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
              {formatNumber(kpis.donorCount)} dons · vs période préc.
            </span>
          </div>
        </article>

        <article className="kpi reveal">
          <div className="kpi-head">
            <div className="kpi-label">
              Revenu Givernance{" "}
              <span
                className="material-symbols-outlined info-i"
                title="1,5% + 0,30€ par don cleared. Normalisé en EUR."
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
            <span className="kpi-foot">take-rate {formatPercent(takeRate, 2)}%</span>
          </div>
        </article>

        <article className="kpi reveal">
          <div className="kpi-head">
            <div className="kpi-label">
              Revenu récurrent{" "}
              <span
                className="material-symbols-outlined info-i"
                title="Part du revenu issue de pledges actifs. Revenu prévisible."
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
            <span className="suffix">/mois</span>
          </div>
          <div className="kpi-meta">
            <span className="delta-pill delta-pill--flat">
              <span className="material-symbols-outlined">remove</span>—
            </span>
            <span className="kpi-foot">
              {Math.round(recurringRatio)}% du volume · pledges actifs
            </span>
          </div>
        </article>

        <article className="kpi reveal">
          <div className="kpi-head">
            <div className="kpi-label">
              Frais Stripe{" "}
              <span
                className="material-symbols-outlined info-i"
                title="Rail Stripe uniquement. Déduit du compte de la NPO."
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
              ~{formatPercent(stripeSharePercent, 2)}% du volume carte
            </span>
          </div>
        </article>
      </div>

      <div className="section-head">
        <h2>Évolution du volume</h2>
        <span className="rule" />
        <span className="hint">Dons clearés / jour · revenu superposé</span>
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
              ariaLabel: "Évolution du volume et du revenu",
              volumeLabel: "Volume",
              revenueLabel: "Revenu",
              formatVolumeTick: (v) => `€${Math.round(v / 1000)}k`,
              formatRevenueTick: (v) => `€${Math.round(v)}`,
              formatVolume: (v) => formatCents(Math.round(v * 100), "EUR", false),
              formatRevenue: (v) => formatCents(Math.round(v * 100), "EUR", false),
            }}
          />
        ) : (
          <p style={{ color: "var(--color-on-surface-variant)" }}>
            Aucune donnée pour la période sélectionnée.
          </p>
        )}
      </div>

      <div className="section-head">
        <h2>Risque &amp; concentration</h2>
        <span className="rule" />
        <span className="hint">Signaux opérationnels plateforme</span>
      </div>
      <div className="risk-grid">
        <div className="risk-item">
          <div className="rl">
            Concentration (HHI){" "}
            <span
              className="material-symbols-outlined info-i"
              title="HHI = somme des carrés des parts. < 0,15 = bien diversifié."
            >
              info
            </span>
          </div>
          <div className="rv">{hhi.toFixed(2)}</div>
          <div className="rs">
            Top tenant ={" "}
            {topTenants[0] && kpis.volumeCents > 0
              ? formatPercent((topTenants[0].volumeCents / kpis.volumeCents) * 100, 1)
              : "0"}{" "}
            %
          </div>
          <span
            className={`risk-badge risk-badge--${hhiVariant === "alert" ? "watch" : hhiVariant}`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
              {hhiVariant === "ok" ? "check_circle" : "warning"}
            </span>
            {hhiVariant === "ok"
              ? "Bien diversifié"
              : hhiVariant === "watch"
                ? "À surveiller"
                : "Trop concentré"}
          </span>
        </div>
        <div className="risk-item">
          <div className="rl">
            Tenants actifs{" "}
            <span
              className="material-symbols-outlined info-i"
              title="Au moins 1 don cleared sur la période."
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
            {tenantCount > 0
              ? formatPercent((kpis.activeTenantsCount / tenantCount) * 100, 0)
              : "0"}
            % actifs · {tenantCount - kpis.activeTenantsCount} dormants
          </div>
        </div>
        <div className="risk-item">
          <div className="rl">
            Taux d'échec paiement{" "}
            <span
              className="material-symbols-outlined info-i"
              title="Stripe uniquement (Mollie non instrumenté)."
            >
              info
            </span>
          </div>
          <div className="rv">{formatPercent(failureRate, 1)} %</div>
          <div className="rs">Sur l'ensemble des tentatives Stripe sur la période.</div>
        </div>
      </div>

      <div className="section-head" id="tenant-health">
        <h2>Santé des tenants</h2>
        <span className="rule" />
        <span className="hint">PMF · NPS · CSAT</span>
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
              Product/Market Fit (Sean Ellis)
              {pmfSurvey && (
                <span className={`fresh-pip fresh-pip--${pmfFreshness}`}>
                  <span className="material-symbols-outlined">schedule</span>
                  {pmfFreshness === "ok"
                    ? "à jour"
                    : pmfFreshness === "soon"
                      ? "bientôt périmé"
                      : "périmé"}
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
                    « Très déçus » si Givernance disparaît. Seuil PMF = <b>40%</b>.
                  </span>
                </div>
                <div className="sentiment-bar-wrap">
                  <div
                    className="sentiment-bar"
                    role="img"
                    aria-label={`PMF: ${Math.round(pmfPercent)}% très déçus`}
                  >
                    <div className="sentiment-seg seg-very" style={{ flex: pmfPercent }}>
                      {Math.round(pmfPercent)}%
                    </div>
                    <div
                      className="sentiment-seg seg-somewhat"
                      style={{ flex: Math.max(0, 80 - pmfPercent) }}
                    >
                      moyennement
                    </div>
                    <div className="sentiment-seg seg-not" style={{ flex: 20 }}>
                      pas déçus
                    </div>
                  </div>
                  <div className="pmf-marker" aria-hidden="true">
                    <span className="line" />
                    <span className="tag">40% seuil</span>
                  </div>
                </div>
                <div className="sentiment-legend">
                  <span className="li">
                    <span className="sw" style={{ background: "var(--color-primary)" }} />
                    <b>Très déçus</b> : signal positif
                  </span>
                  <span className="li">
                    <span
                      className="sw"
                      style={{ background: "var(--color-tertiary-fixed-dim)" }}
                    />{" "}
                    Moyennement
                  </span>
                  <span className="li">
                    <span
                      className="sw"
                      style={{ background: "var(--color-surface-container-highest)" }}
                    />{" "}
                    Pas déçus
                  </span>
                </div>
              </>
            ) : (
              <p style={{ color: "var(--color-on-surface-variant)", marginTop: 8 }}>
                Pas encore de réponses PMF. Lance un envoi pour collecter.
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
                NPS
                {npsSurvey && (
                  <span className={`fresh-pip fresh-pip--${npsFreshness}`}>
                    <span className="material-symbols-outlined">schedule</span>
                    {npsFreshness === "ok" ? "à jour" : "périmé"}
                  </span>
                )}
              </div>
              <div className="v">
                {npsSurvey?.npsScore !== null && npsSurvey?.npsScore !== undefined
                  ? Math.round(npsSurvey.npsScore)
                  : "—"}
                <small>/ 100</small>
              </div>
              <span className="legacy">indicateur historique</span>
            </div>
            <div className="sat-mini">
              <div className="l">
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 14, color: "var(--color-primary)" }}
                >
                  sentiment_satisfied
                </span>
                CSAT post-ticket
                {csatSurvey && (
                  <span className={`fresh-pip fresh-pip--${csatFreshness}`}>
                    <span className="material-symbols-outlined">schedule</span>
                    {csatFreshness === "ok" ? "à jour" : "périmé"}
                  </span>
                )}
              </div>
              <div className="v">
                {csatSurvey?.csatScore !== null && csatSurvey?.csatScore !== undefined
                  ? csatSurvey.csatScore.toFixed(1)
                  : "—"}
                <small>/ 5</small>
              </div>
            </div>
            {atRiskCount > 0 && (
              <div className="sat-mini" style={{ background: "var(--color-error-container)" }}>
                <div className="l" style={{ color: "var(--color-on-error-container)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                    crisis_alert
                  </span>
                  À recontacter
                </div>
                <div className="v" style={{ color: "var(--color-on-error-container)" }}>
                  {atRiskCount}
                  <small style={{ color: "var(--color-on-error-container)" }}>tenants</small>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>Tenants &amp; flux</h2>
        <span className="rule" />
        <span className="hint">Top contributeurs · remboursements · devises</span>
      </div>
      <div className="two-col">
        <div className="fin-card">
          <div className="fin-card-header">
            <div>
              <div className="fin-card-title">Top tenants · volume</div>
              <div className="fin-card-subtitle">Par volume de dons clearés sur la période</div>
            </div>
          </div>
          {topTenants.length > 0 ? (
            <>
              <div className="tenant-row head">
                <span />
                <span>Tenant · part</span>
                <span style={{ textAlign: "right" }}>Score</span>
                <span style={{ textAlign: "right" }}>Volume</span>
              </div>
              {topTenants.map((t, idx) => {
                const sharePct =
                  kpis.volumeCents > 0 ? (t.volumeCents / kpis.volumeCents) * 100 : 0;
                const mob = mobilisation.perTenant.find((m) => m.tenantId === t.tenantId);
                return (
                  <div key={t.tenantId} className="tenant-row">
                    <span className="tenant-rank">{String(idx + 1).padStart(2, "0")}</span>
                    <div style={{ minWidth: 0 }}>
                      <a href={`/admin/tenants/${t.tenantId}`} className="tenant-name">
                        {t.tenantName}
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
                      {formatCents(t.volumeCents, "EUR", false)}
                      <small>{formatNumber(t.donationCount)} dons</small>
                    </span>
                  </div>
                );
              })}
            </>
          ) : (
            <p style={{ color: "var(--color-on-surface-variant)" }}>
              Aucun tenant avec dons sur la période.
            </p>
          )}
        </div>
        <div className="stack">
          <div className="fin-card">
            <div className="fin-card-header">
              <div>
                <div className="fin-card-title">Taux de remboursement</div>
                <div className="fin-card-subtitle">Sain &lt; 1% · alerte &gt; 5%</div>
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
                0%
              </span>
              <span className="t" style={{ left: "12.5%" }}>
                1%
              </span>
              <span className="t" style={{ left: "62.5%" }}>
                5%
              </span>
              <span className="t" style={{ left: "100%" }}>
                8%+
              </span>
            </div>
            <p className="kpi-foot" style={{ marginTop: "var(--space-3)" }}>
              {formatCents(kpis.refundedVolumeCents, "EUR", false)} remboursés.
            </p>
          </div>
          <div className="fin-card">
            <div className="fin-card-header">
              <div>
                <div className="fin-card-title">Devises</div>
                <div className="fin-card-subtitle">Répartition du volume</div>
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
        Cette vue a été chargée à {lastTimestamp}. Source :{" "}
        <code>/v1/superadmin/finance/summary</code>. Cache 5 min. Toute consultation est tracée dans{" "}
        <code>audit_logs</code>.
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
          {flushing ? "Flush en cours…" : "Forcer un rafraîchissement"}
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
          Mise à jour…
        </div>
      )}
    </main>
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
        Répartition · {tenantCount} tenants
      </button>
      <div
        className="hero-hist"
        role="img"
        aria-label={buckets.map((b) => `${b.count} tenants ${b.key}`).join(", ")}
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
          ? `Score : ${score} · ${timeLeft}s`
          : gameOver
            ? `Game over — score final : ${score}`
            : `Distribution sur ${tenantCount} tenants. Tenants avec < 5 donateurs uniques exclus (k-anonymity).`}
      </p>
    </div>
  );
}
