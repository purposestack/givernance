"use client";

import {
  AlertTriangle,
  Download,
  Eye,
  FileArchive,
  Loader2,
  MailPlus,
  RefreshCcw,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

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
  initialExports: PostalExport[];
  /** Number of constituents currently linked — used to disable "personalized" when 0. */
  linkedConstituentCount: number;
}

/**
 * Postal export workspace (Epic #274).
 *
 * Renders mode toggle (door-drop / personalized) + Preview + Generate buttons,
 * the active job's progress bar (polled every 2s while pending|processing),
 * and the recent-jobs history list with per-row download links.
 */
export function PostalExportPanel({
  campaignId,
  campaignType,
  campaignStatus,
  publicPageStatus,
  initialExports,
  linkedConstituentCount,
}: PostalExportPanelProps) {
  const t = useTranslations("campaigns.postal");
  const [mode, setMode] = useState<PostalExportMode>(
    campaignType === "door_drop" ? "door_drop" : "personalized",
  );
  const [exports, setExports] = useState<PostalExport[]>(initialExports);
  const [isStarting, setIsStarting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const activeJob = exports.find((e) => e.status === "pending" || e.status === "processing");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Polling lifecycle: keep a 2s ticker running whenever there's at least one
  // in-flight job. Tear down when the list is fully terminal so we're not
  // hammering the API on idle tabs.
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
        if (fresh.status === "completed") toast.success(t("toast.exportReady"));
        if (fresh.status === "failed") toast.error(fresh.error ?? t("toast.exportFailed"));
      } catch (err) {
        if (err instanceof ApiProblem && err.status === 404) {
          stopPolling();
        }
      }
    };
    pollRef.current = setInterval(() => void tick(), 2000);

    return stopPolling;
  }, [activeJob, campaignId, t]);

  const refreshList = useCallback(async () => {
    const client = createClientApiClient();
    try {
      const fresh = await PostalCampaignService.listExports(client, campaignId);
      setExports(fresh);
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("toast.refreshFailed"))
          : t("toast.refreshFailed");
      toast.error(message);
    }
  }, [campaignId, t]);

  const handleStart = useCallback(async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      const client = createClientApiClient();
      const newExport = await PostalCampaignService.startExport(client, campaignId, mode);
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
  }, [campaignId, isStarting, mode, t]);

  const handlePreview = useCallback(async () => {
    if (isPreviewing) return;
    setIsPreviewing(true);
    // Open in a new tab via form submit so the browser handles the
    // `application/pdf` response natively. We keep the popup synchronous
    // to the click for popup-blocker friendliness, then redirect to the
    // actual URL once we've gone through the CSRF + cookie hop.
    const previewUrl = PostalCampaignService.previewPdfUrl(campaignId);
    try {
      // The auth plugin's CSRF double-submit guard reads from the
      // `csrf-token` cookie — NOT a `csrf=` cookie. The previous inline
      // reader (`c.startsWith("csrf=")`) never matched and the request
      // went out without the header → auth plugin rejected with 403.
      // Reuse the canonical helper so the preview path stays in lockstep
      // with the rest of the app's mutating fetches.
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
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      // Best-effort cleanup; the new tab still has its own reference.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("toast.previewFailed");
      toast.error(message);
    } finally {
      setIsPreviewing(false);
    }
  }, [campaignId, isPreviewing, mode, t]);

  const personalizedDisabled = campaignType === "door_drop" || linkedConstituentCount === 0;

  // Readiness gates (Epic #274). The Preview button is intentionally NOT
  // gated — it produces a fake-data sample with a never-registered QR
  // token so the operator can validate the layout before publishing the
  // public donation page. The Generate ZIP button blocks until both
  // gates pass; the API enforces the same checks (defense-in-depth).
  const campaignNotActive = campaignStatus !== "active";
  const publicPageNotReady = publicPageStatus !== "published";
  const generateBlocked = campaignNotActive || publicPageNotReady;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileArchive size={18} aria-hidden="true" />
            {t("title")}
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void refreshList()}
          aria-label={t("refresh")}
        >
          <RefreshCcw size={16} aria-hidden="true" />
          {t("refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {generateBlocked ? (
          <ReadinessBanners
            campaignId={campaignId}
            campaignNotActive={campaignNotActive}
            publicPageStatus={publicPageStatus}
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

        <div className="flex flex-wrap items-center gap-3">
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
            title={
              generateBlocked
                ? campaignNotActive
                  ? t("readiness.activateCampaignFirst")
                  : t("readiness.publishPublicPageFirst")
                : undefined
            }
          >
            {isStarting ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                {t("actions.starting")}
              </>
            ) : (
              <>
                <FileArchive size={16} aria-hidden="true" />
                {t("actions.generateZip")}
              </>
            )}
          </Button>
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

function ExportRow({ job, campaignId }: { job: PostalExport; campaignId: string }) {
  const t = useTranslations("campaigns.postal.history");
  const created = new Date(job.createdAt);
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="flex flex-1 items-center gap-3">
        <StatusBadge status={job.status} />
        <span className="text-on-surface-variant">
          {created.toLocaleString()} · {t(`mode.${job.mode}`)} ·{" "}
          {t("counts", { progress: job.progressCount, total: job.totalCount })}
        </span>
      </div>
      {job.status === "completed" ? (
        <a
          href={PostalCampaignService.exportDownloadUrl(campaignId, job.id)}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          <Download size={14} aria-hidden="true" />
          {t("download")}
        </a>
      ) : null}
    </li>
  );
}

function StatusBadge({ status }: { status: PostalExport["status"] }) {
  const variants: Record<PostalExport["status"], "neutral" | "info" | "success" | "error"> = {
    pending: "neutral",
    processing: "info",
    completed: "success",
    failed: "error",
  };
  const labels: Record<PostalExport["status"], string> = {
    pending: "Pending",
    processing: "Processing",
    completed: "Completed",
    failed: "Failed",
  };
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
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
function ReadinessBanners({
  campaignId,
  campaignNotActive,
  publicPageStatus,
}: {
  campaignId: string;
  campaignNotActive: boolean;
  publicPageStatus: "missing" | "draft" | "published";
}) {
  const t = useTranslations("campaigns.postal.readiness");
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
      {publicPageStatus !== "published" ? (
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
    </div>
  );
}
