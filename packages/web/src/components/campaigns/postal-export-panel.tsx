"use client";

import {
  type PostalExportRunMode,
  resolvePostalExportMode,
} from "@givernance/shared/postal-export-mode";
import { hasPageFromStatus } from "@givernance/shared/postal-print-layout";
import {
  AlertTriangle,
  Banknote,
  Download,
  Eye,
  FileArchive,
  FileText,
  Loader2,
  MailPlus,
  RefreshCcw,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";
import type { Campaign, CampaignType } from "@/models/campaign";
import {
  PostalCampaignService,
  type PostalExport,
  type PostalExportFormat,
  type PostalExportMode,
} from "@/services/PostalCampaignService";

interface PostalExportPanelProps {
  campaignId: string;
  campaignType: CampaignType;
  /**
   * Drives the "campaign must be active" readiness banner. Mirrors the
   * server-side gate in `startPostalExport` (Epic #274) — a draft or
   * closed campaign returns `400 campaign_not_active` from the API.
   */
  campaignStatus: Campaign["status"];
  /**
   * Drives the "publish your public donation page" readiness banner.
   * Mirrors the server-side gates `public_page_missing` /
   * `public_page_draft` in `startPostalExport`. We carry the
   * `missing` / `draft` distinction so the banner copy and CTA match
   * the operator's actual blocker (configure the page vs. flip its
   * status).
   */
  publicPageStatus: "missing" | "draft" | "published";
  /**
   * Epic #318 PR #4 — Swiss QR-bill discriminator. NULL = no bank
   * account linked (standard postal mode); set = QR-bill or hybrid
   * mode depending on whether the public page is also published.
   * Drives the mode-summary panel + the mode-aware button label.
   */
  bankAccount: {
    bankName: string;
    /** Last 4 digits of the IBAN — surfaced in the summary panel. */
    ibanLast4: string;
    currency: "CHF" | "EUR";
  } | null;
  initialExports: PostalExport[];
  /** Number of constituents currently linked — used to disable "personalized" when 0. */
  linkedConstituentCount: number;
  /**
   * Whether the `campaign.postal_merged_pdf` flag is enabled for this
   * tenant (project item #194221573). SSR-resolved in the page server
   * component. When false the format selector is rendered NOWHERE — the
   * export is always a ZIP, exactly as before the option existed.
   */
  mergedPdfEnabled: boolean;
}

/**
 * Postal export workspace (Epic #274).
 *
 * Renders mode toggle (door-drop / personalized) + Preview + Generate buttons,
 * the active job's progress bar (polled every 2s while pending|processing),
 * and the recent-jobs history list with per-row download links.
 *
 * Epic #318 PR #4 adds the mode-summary panel + mode-aware button label
 * + content-type-aware preview handler. Complexity is intrinsic to a
 * component with this many state branches (Swiss mode resolution +
 * polling + start + preview + readiness gates). Extracting more would
 * make the code less readable, not more.
 */
export function PostalExportPanel({
  campaignId,
  campaignType,
  campaignStatus,
  publicPageStatus,
  bankAccount,
  initialExports,
  linkedConstituentCount,
  mergedPdfEnabled,
}: PostalExportPanelProps) {
  const t = useTranslations("campaigns.postal");
  const [mode, setMode] = useState<PostalExportMode>(
    campaignType === "door_drop" ? "door_drop" : "personalized",
  );
  // Output format (project item #194221573). Always `zip` unless the
  // operator opts into the merged PDF — which is only offered when the
  // flag is on (the selector is hidden otherwise).
  const [format, setFormat] = useState<PostalExportFormat>("zip");

  // Epic #318 PR #4 — resolve the run mode the same way the API and worker
  // resolve it. Single source of truth in `@givernance/shared/postal-export-mode`,
  // and `hasPageFromStatus` from `@givernance/shared/postal-print-layout` so the
  // web layer derives `hasPage` from the public-page status with exactly the
  // same rule the API and worker use.
  const runMode: PostalExportRunMode = useMemo(
    () =>
      resolvePostalExportMode({
        hasBank: bankAccount !== null,
        // Shared helper accepts `draft | published | null | undefined`. The
        // web type carries an extra `"missing"` sentinel that represents
        // "no row in `campaign_public_pages`" — map it to `null` so the
        // helper returns `false` (same as missing).
        hasPage: hasPageFromStatus(publicPageStatus === "missing" ? null : publicPageStatus),
      }),
    [bankAccount, publicPageStatus],
  );
  const [exports, setExports] = useState<PostalExport[]>(initialExports);
  const [isStarting, setIsStarting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const activeJob = exports.find((e) => e.status === "pending" || e.status === "processing");

  useExportPolling({ activeJob, campaignId, setExports, t });

  const refreshList = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const client = createClientApiClient();
    try {
      const fresh = await PostalCampaignService.listExports(client, campaignId);
      setExports(fresh);
      toast.success(t("toast.refreshed"));
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("toast.refreshFailed"))
          : t("toast.refreshFailed");
      toast.error(message);
    } finally {
      setIsRefreshing(false);
    }
  }, [campaignId, isRefreshing, t]);

  const handleStart = useCallback(async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      const client = createClientApiClient();
      // Only send `merged_pdf` when the flag-gated selector is visible —
      // belt-and-suspenders so a stale `format` state can never request a
      // disabled artefact (the API would reject it anyway).
      const requestedFormat: PostalExportFormat = mergedPdfEnabled ? format : "zip";
      const newExport = await PostalCampaignService.startExport(
        client,
        campaignId,
        mode,
        requestedFormat,
      );
      setExports((prev) => [newExport, ...prev]);
      toast.success(t("toast.exportQueued"));
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("toast.startFailed"))
          : t("toast.startFailed");
      toast.error(message);
    } finally {
      setIsStarting(false);
    }
  }, [campaignId, isStarting, mode, format, mergedPdfEnabled, t]);

  const handlePreview = useCallback(async () => {
    if (isPreviewing) return;
    setIsPreviewing(true);
    try {
      await fetchAndOpenPreview({
        campaignId,
        mode,
        // n2 — locale-aware download filename for the hybrid-preview ZIP.
        // We resolve it at the call site (component scope) instead of inside
        // the helper so the helper stays a plain fetch/UI plumbing function
        // with no next-intl dependency.
        zipFilename: t("preview.zipFilename"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("toast.previewFailed");
      toast.error(message);
    } finally {
      setIsPreviewing(false);
    }
  }, [campaignId, isPreviewing, mode, t]);

  const personalizedDisabled = campaignType === "door_drop" || linkedConstituentCount === 0;

  // Epic #318 PR #4 — mode-aware readiness gates.
  // The public-page banner only fires in `standard` / `hybrid` (modes that
  // emit an appeal letter with a Givernance scan QR). `qr_bill_only` mode
  // has no public page to scan to. `blocked` mode shows its own banner.
  const campaignNotActive = campaignStatus !== "active";
  const publicPageNotReady =
    (runMode === "standard" || runMode === "hybrid") && publicPageStatus !== "published";
  const exportNotConfigured = runMode === "blocked";
  const generateBlocked = campaignNotActive || publicPageNotReady || exportNotConfigured;

  // Project item #194221573 — the Generate CTA names the artefact it will
  // produce: the merged-PDF label when that format is selected, else the
  // existing mode-keyed "Generate ZIP" label.
  const showFormatSelector = mergedPdfEnabled;
  const effectiveFormat: PostalExportFormat = showFormatSelector ? format : "zip";
  const generateLabel =
    effectiveFormat === "merged_pdf"
      ? t("actions.generateMergedPdf")
      : t(`actions.generateZip.${runMode}`);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileArchive size={18} aria-hidden="true" />
            {t("title")}
          </CardTitle>
          {/* Epic #318 PR #4 — mode-keyed description so the card header
              matches the actual export shape (appeal letter / QR-bill /
              hybrid / blocked) instead of a one-size-fits-all string that
              lies in qr_bill_only and blocked modes. */}
          <CardDescription>{t(`description.${runMode}`)}</CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void refreshList()}
          disabled={isRefreshing}
          aria-label={t("refresh")}
        >
          <RefreshCcw
            size={16}
            className={isRefreshing ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          {isRefreshing ? t("refreshing") : t("refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <ModeSummaryPanel
          runMode={runMode}
          bankAccount={bankAccount}
          campaignId={campaignId}
          campaignType={campaignType}
        />

        {generateBlocked ? (
          <ReadinessBanners
            campaignId={campaignId}
            campaignNotActive={campaignNotActive}
            publicPageStatus={publicPageStatus}
            runMode={runMode}
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <ModeOption
            active={mode === "personalized"}
            disabled={personalizedDisabled}
            onSelect={() => setMode("personalized")}
            icon={<MailPlus size={18} aria-hidden="true" />}
            title={t("modes.personalized.title")}
            description={
              personalizedDisabled
                ? campaignType === "door_drop"
                  ? t("modes.personalized.disabledDoorDrop")
                  : t("modes.personalized.disabledNoRecipients")
                : t("modes.personalized.description", {
                    count: linkedConstituentCount,
                  })
            }
          />
          <ModeOption
            active={mode === "door_drop"}
            disabled={false}
            onSelect={() => setMode("door_drop")}
            icon={<FileArchive size={18} aria-hidden="true" />}
            title={t("modes.doorDrop.title")}
            description={t("modes.doorDrop.description")}
          />
        </div>

        {/* Output format selector (project item #194221573) — rendered only
            when the `campaign.postal_merged_pdf` flag is on. With the flag
            off this block is absent entirely and every export is a ZIP. */}
        {showFormatSelector ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-on-surface">{t("formats.label")}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <ModeOption
                active={format === "zip"}
                disabled={false}
                onSelect={() => setFormat("zip")}
                icon={<FileArchive size={18} aria-hidden="true" />}
                title={t("formats.zip.title")}
                description={t("formats.zip.description")}
              />
              <ModeOption
                active={format === "merged_pdf"}
                disabled={false}
                onSelect={() => setFormat("merged_pdf")}
                icon={<FileText size={18} aria-hidden="true" />}
                title={t("formats.mergedPdf.title")}
                description={t("formats.mergedPdf.description")}
              />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {/*
            m1 — a11y for the disabled CTA. `title` is famously inaccessible
            on disabled buttons (no keyboard reveal, and screen-readers often
            skip it entirely). Pair it with an `aria-label` that concatenates
            the visible label with the blocker reason, so SR users hear the
            "why" even when the visual title tooltip doesn't fire.
          */}
          {(() => {
            const blockerReason = !generateBlocked
              ? null
              : campaignNotActive
                ? t("readiness.activateCampaignFirst")
                : exportNotConfigured
                  ? t("readiness.notConfiguredTooltip")
                  : t("readiness.publishPublicPageFirst");
            const buttonAriaLabel =
              generateBlocked && blockerReason ? `${generateLabel} — ${blockerReason}` : undefined;
            return (
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleStart()}
                disabled={
                  isStarting ||
                  (mode === "personalized" && personalizedDisabled) ||
                  activeJob !== undefined ||
                  generateBlocked
                }
                title={blockerReason ?? undefined}
                aria-label={buttonAriaLabel}
              >
                {isStarting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    {t("actions.starting")}
                  </>
                ) : (
                  <>
                    <FileArchive size={16} aria-hidden="true" />
                    {generateLabel}
                  </>
                )}
              </Button>
            );
          })()}
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handlePreview()}
            disabled={isPreviewing}
          >
            {isPreviewing ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                {t("actions.previewing")}
              </>
            ) : (
              <>
                <Eye size={16} aria-hidden="true" />
                {t("actions.preview")}
              </>
            )}
          </Button>
        </div>

        {activeJob ? <ActiveJobProgress job={activeJob} /> : null}

        {exports.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-on-surface">{t("history.title")}</h3>
            <ul className="divide-y divide-outline-variant rounded-lg border border-outline-variant">
              {exports.map((row) => (
                <ExportRow key={row.id} job={row} campaignId={campaignId} />
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ModeOption({
  active,
  disabled,
  onSelect,
  icon,
  title,
  description,
}: {
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
      className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${
        active
          ? "border-primary bg-primary/5"
          : "border-outline-variant bg-surface-container hover:border-primary/40"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className="mt-0.5 text-primary">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-on-surface">{title}</span>
        <span className="mt-1 block text-xs text-on-surface-variant">{description}</span>
      </span>
    </button>
  );
}

function ActiveJobProgress({ job }: { job: PostalExport }) {
  const t = useTranslations("campaigns.postal.progress");
  const pct = job.totalCount > 0 ? Math.round((job.progressCount / job.totalCount) * 100) : 0;
  const cappedPct = Math.min(100, pct);
  return (
    <div className="rounded-xl bg-surface-container p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-on-surface">
          {job.status === "pending" ? t("queued") : t("processing")}
        </span>
        <span className="font-mono text-sm tabular-nums text-on-surface-variant">
          {job.progressCount} / {job.totalCount}
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-md bg-surface-container-highest"
        role="progressbar"
        aria-label={t(job.status === "pending" ? "queued" : "processing")}
        aria-valuenow={cappedPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-md bg-primary transition-all duration-500 ease-out"
          style={{ width: `${cappedPct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Compact chip telling the operator which artefact this export produced —
 * a ZIP of separate PDFs or one merged PDF (project item #194221573). The
 * two get distinct tones + icons so the generation type is legible at a
 * glance in the history list.
 */
function FormatChip({ format }: { format: PostalExport["format"] }) {
  const t = useTranslations("campaigns.postal.history.format");
  const isMerged = format === "merged_pdf";
  return (
    <Badge variant={isMerged ? "info" : "neutral"} className="gap-1">
      {isMerged ? (
        <FileText size={12} aria-hidden="true" />
      ) : (
        <FileArchive size={12} aria-hidden="true" />
      )}
      {t(format)}
    </Badge>
  );
}

function ExportRow({ job, campaignId }: { job: PostalExport; campaignId: string }) {
  const t = useTranslations("campaigns.postal.history");
  const locale = useLocale();
  const createdAt = new Date(job.createdAt).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const inFlight = job.status === "pending" || job.status === "processing";

  // Recipient/scope descriptor — a real count for personalised mailings,
  // a "generic letter" label for door-drops (where total_count is always 1
  // and "1/1" reads as noise to the operator).
  const scope =
    job.mode === "personalized" ? t("recipients", { count: job.totalCount }) : t("genericLetter");

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={job.status} />
          <span className="font-medium text-on-surface">{t(`mode.${job.mode}`)}</span>
          <FormatChip format={job.format} />
        </div>
        <span className="text-xs text-on-surface-variant">
          {createdAt} · {scope}
          {/* While the job is still generating, surface live progress so the
              row mirrors the active-job progress bar above. */}
          {inFlight ? (
            <> · {t("counts", { progress: job.progressCount, total: job.totalCount })}</>
          ) : null}
          {job.status === "failed" && job.error ? (
            <span className="text-error"> · {job.error}</span>
          ) : null}
        </span>
      </div>
      {job.status === "completed" ? (
        <a
          href={PostalCampaignService.exportDownloadUrl(campaignId, job.id)}
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          <Download size={14} aria-hidden="true" />
          {t("download")}
        </a>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { status: PostalExport["status"] }) {
  const t = useTranslations("campaigns.postal.history.status");
  const variants: Record<PostalExport["status"], "neutral" | "info" | "success" | "error"> = {
    pending: "neutral",
    processing: "info",
    completed: "success",
    failed: "error",
  };
  return <Badge variant={variants[status]}>{t(status)}</Badge>;
}

/**
 * Readiness banners (Epic #274). Surface the API's `startPostalExport`
 * pre-conditions in the UI so the operator sees exactly what's missing
 * — and the CTA to fix it — before clicking Generate.
 *
 * The banners are stacked: campaign-status comes first because activating
 * the campaign is generally the prerequisite to publishing the public
 * page (a draft campaign is still being scoped). When both are blocked
 * the operator gets two banners with two distinct CTAs.
 */
/**
 * Fetch the preview PDF (or ZIP for hybrid mode) and open it in the
 * browser. Extracted from `PostalExportPanel.handlePreview` so the
 * component stays under the biome cognitive-complexity ceiling.
 */
async function fetchAndOpenPreview({
  campaignId,
  mode,
  zipFilename,
}: {
  campaignId: string;
  mode: PostalExportMode;
  zipFilename: string;
}): Promise<void> {
  const previewUrl = PostalCampaignService.previewPdfUrl(campaignId);
  // The auth plugin's CSRF double-submit guard reads from the
  // `csrf-token` cookie — keep this path in lockstep with the rest of
  // the app's mutating fetches.
  const csrf = readCsrfTokenFromDocumentCookie();

  const response = await fetch(previewUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { [getCsrfHeaderName()]: csrf } : {}),
    },
    body: JSON.stringify({ mode }),
  });

  if (!response.ok) {
    throw new Error(`Preview failed (${response.status})`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  // Epic #318 PR #4 — content-type dispatch:
  //   - `application/pdf` → open inline in new tab (standard, qr_bill_only)
  //   - `application/zip` → trigger download (hybrid: two PDFs per recipient)
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/zip")) {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = zipFilename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } else {
    window.open(objectUrl, "_blank", "noopener,noreferrer");
  }
  // Best-effort cleanup; the new tab still has its own reference.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/**
 * Polling lifecycle extracted out of `PostalExportPanel` so the component
 * stays under the biome cognitive-complexity ceiling. Keeps a 2s ticker
 * running whenever there's at least one in-flight job; tears down when
 * the list is fully terminal so idle tabs don't hammer the API.
 */
function useExportPolling({
  activeJob,
  campaignId,
  setExports,
  t,
}: {
  activeJob: PostalExport | undefined;
  campaignId: string;
  setExports: React.Dispatch<React.SetStateAction<PostalExport[]>>;
  t: ReturnType<typeof useTranslations>;
}): void {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // m3 — `t` from `useTranslations()` is NOT guaranteed stable across renders
  // (next-intl returns a fresh function reference each call). Including it in
  // the effect dep array tears down + re-starts the poll interval on every
  // parent re-render, which can drop the 2s rhythm. Capture it in a ref so
  // the effect can call the latest `t` without re-subscribing.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!activeJob) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;

    const client = createClientApiClient();
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const tick = async () => {
      try {
        const fresh = await PostalCampaignService.getExport(client, campaignId, activeJob.id);
        setExports((prev) => prev.map((e) => (e.id === fresh.id ? fresh : e)));
        // Stop BEFORE firing the toast — the next 2s tick can land before
        // the React effect cleanup re-runs and would duplicate toasts.
        if (fresh.status === "completed") {
          stopPolling();
          toast.success(tRef.current("toast.exportReady"));
        }
        if (fresh.status === "failed") {
          stopPolling();
          toast.error(fresh.error ?? tRef.current("toast.exportFailed"));
        }
      } catch (err) {
        if (err instanceof ApiProblem && err.status === 404) {
          stopPolling();
        }
      }
    };
    pollRef.current = setInterval(() => void tick(), 2000);
    return stopPolling;
  }, [activeJob, campaignId, setExports]);
}

function ReadinessBanners({
  campaignId,
  campaignNotActive,
  publicPageStatus,
  runMode,
}: {
  campaignId: string;
  campaignNotActive: boolean;
  publicPageStatus: "missing" | "draft" | "published";
  runMode: PostalExportRunMode;
}) {
  const t = useTranslations("campaigns.postal.readiness");
  // Epic #318 PR #4 — public-page banner only fires in modes that emit
  // an appeal letter with a scan-QR. QR-bill-only mode has no scan-QR.
  const publicPageBannerActive =
    publicPageStatus !== "published" && (runMode === "standard" || runMode === "hybrid");
  const notConfiguredBannerActive = runMode === "blocked";
  return (
    <div className="space-y-3">
      {campaignNotActive ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-on-surface">
          <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="font-medium">{t("campaignNotActive.title")}</p>
            <p className="mt-1 text-on-surface-variant">{t("campaignNotActive.body")}</p>
          </div>
        </div>
      ) : null}
      {publicPageBannerActive ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-on-surface">
          <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="font-medium">
              {publicPageStatus === "missing"
                ? t("publicPageMissing.title")
                : t("publicPageDraft.title")}
            </p>
            <p className="mt-1 text-on-surface-variant">
              {publicPageStatus === "missing"
                ? t("publicPageMissing.body")
                : t("publicPageDraft.body")}
            </p>
            <Link
              href={`/campaigns/${campaignId}/public-page`}
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              {t("publicPageCta")}
            </Link>
          </div>
        </div>
      ) : null}
      {notConfiguredBannerActive ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-on-surface">
          <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="font-medium">{t("notConfigured.title")}</p>
            <p className="mt-1 text-on-surface-variant">{t("notConfigured.body")}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Link
                href={`/campaigns/${campaignId}/public-page`}
                className="text-sm font-medium text-primary hover:underline"
              >
                {t("notConfigured.publicPageCta")}
              </Link>
              <Link
                href={`/campaigns/${campaignId}/edit`}
                className="text-sm font-medium text-primary hover:underline"
              >
                {t("notConfigured.bankAccountCta")}
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Epic #318 PR #4 — Mode summary panel rendered above the readiness banners.
 *
 * The operator chose the mode upstream (link a bank account / publish a
 * public page); this panel REFLECTS that choice rather than re-asking it.
 * It tells them exactly what the export will produce, plus a single-line
 * "this mode is selected because …" explainer that turns the upstream
 * configuration into something they can click to change.
 */
function ModeSummaryPanel({
  runMode,
  bankAccount,
  campaignId,
  campaignType,
}: {
  runMode: PostalExportRunMode;
  bankAccount: PostalExportPanelProps["bankAccount"];
  campaignId: string;
  campaignType: CampaignType;
}) {
  const t = useTranslations("campaigns.postal.modeSummary");
  const bankAccountLabel = bankAccount
    ? `${bankAccount.bankName} · ****${bankAccount.ibanLast4} · ${bankAccount.currency}`
    : "—";
  const reasonText =
    runMode === "standard"
      ? t("reason.standard")
      : runMode === "qr_bill_only"
        ? t("reason.qr_bill_only", { bank: bankAccountLabel })
        : runMode === "hybrid"
          ? t("reason.hybrid", { bank: bankAccountLabel })
          : t("reason.blocked");

  // Epic #318 PR #4 — only render the scope sub-label in modes that actually
  // mint a QR-bill reference. In `standard` the letter has no QR-bill, and
  // in `blocked` nothing prints — neither needs the per-recipient vs.
  // per-campaign disambiguation.
  const showScopeSubLabel = runMode === "qr_bill_only" || runMode === "hybrid";
  const scopeKey = campaignType === "door_drop" ? "door_drop" : "personalized";
  const contentsHeadingId = `postal-mode-summary-contents-${campaignId}`;

  return (
    // m2 — wrap as a labelled section so screen readers can navigate the
    // mode-summary card by landmark. The `aria-labelledby` points at the
    // contents heading so the announced name is meaningful.
    <section aria-labelledby={contentsHeadingId} className="rounded-xl bg-surface-container p-4">
      <div className="flex items-center gap-2">
        <Badge variant={runMode === "blocked" ? "warning" : "info"}>{t(`badge.${runMode}`)}</Badge>
        {bankAccount ? (
          <Banknote size={14} aria-hidden="true" className="text-on-surface-variant" />
        ) : null}
      </div>
      {showScopeSubLabel ? (
        <p className="mt-1 text-xs text-on-surface-variant">{t(`scope.${scopeKey}`)}</p>
      ) : null}
      <h3 id={contentsHeadingId} className="mt-2 text-sm font-medium text-on-surface">
        {t("contentsHeading")}
      </h3>
      <ul className="mt-1 space-y-0.5 text-sm text-on-surface-variant">
        {runMode === "standard" || runMode === "hybrid" ? (
          <li>✓ {t("contents.appealLetter")}</li>
        ) : null}
        {runMode === "qr_bill_only" || runMode === "hybrid" ? (
          <li>✓ {t("contents.qrBill")}</li>
        ) : null}
        {runMode === "blocked" ? <li>✗ {t("contents.nothing")}</li> : null}
      </ul>
      <p className="mt-3 text-xs text-on-surface-variant">
        {reasonText}{" "}
        <Link
          href={`/campaigns/${campaignId}/edit`}
          className="font-medium text-primary hover:underline"
        >
          {t("reason.editLink")}
        </Link>
      </p>
    </section>
  );
}
