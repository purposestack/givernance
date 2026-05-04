"use client";

/**
 * Postal-mailing card for the campaign detail page (Epic #274).
 *
 * Combines three concerns into a single client component because they
 * share state (the linked-recipients list drives the export "ready"
 * affordances and the per-recipient reconciled-amount metric):
 *   - Linked recipients view + add/remove (nominative campaigns only).
 *   - Preview PDF (synchronous — opens in a new tab).
 *   - ZIP archive export with progress polling and signed download URL.
 */

import { Download, Eye, FileArchive, Loader2, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import {
  type CampaignExportJob,
  CampaignService,
  type LinkedConstituentRow,
} from "@/services/CampaignService";
import { ConstituentService } from "@/services/ConstituentService";

interface PostalMailingCardProps {
  campaignId: string;
  campaignName: string;
  campaignType: "nominative_postal" | "door_drop" | "digital";
  initialLinked: LinkedConstituentRow[];
  initialLinkedTotal: number;
}

/** Polling cadence for an in-flight export job. Worker bumps progress per PDF. */
const JOB_POLL_INTERVAL_MS = 1500;
/** Hard cap on poll attempts to avoid runaway intervals if the worker is wedged. */
const JOB_POLL_MAX_ATTEMPTS = 600;

export function PostalMailingCard({
  campaignId,
  campaignName: _campaignName,
  campaignType,
  initialLinked,
  initialLinkedTotal,
}: PostalMailingCardProps) {
  const [linked, setLinked] = useState<LinkedConstituentRow[]>(initialLinked);
  const [linkedTotal, setLinkedTotal] = useState<number>(initialLinkedTotal);
  const [isAdding, setIsAdding] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{ id: string; firstName: string; lastName: string; email: string | null }>
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activeJob, setActiveJob] = useState<CampaignExportJob | null>(null);
  const [previousJobs, setPreviousJobs] = useState<CampaignExportJob[]>([]);
  const pollAttemptsRef = useRef(0);

  const isNominative = campaignType === "nominative_postal";
  const isDoorDrop = campaignType === "door_drop";
  const isDigital = campaignType === "digital";

  const refreshLinked = useCallback(async () => {
    try {
      const result = await CampaignService.listLinkedConstituents(
        createClientApiClient(),
        campaignId,
        { page: 1, perPage: 50 },
      );
      setLinked(result.data);
      setLinkedTotal(result.pagination.total);
    } catch (err) {
      if (err instanceof ApiProblem) {
        toast.error(err.detail ?? err.title ?? "Failed to load recipients");
      }
    }
  }, [campaignId]);

  const refreshExports = useCallback(async () => {
    try {
      const jobs = await CampaignService.listExports(createClientApiClient(), campaignId);
      const inFlight = jobs.find((j) => j.status === "pending" || j.status === "processing");
      setActiveJob(inFlight ?? null);
      setPreviousJobs(jobs.filter((j) => j.status === "completed" || j.status === "failed"));
    } catch (err) {
      if (err instanceof ApiProblem) {
        toast.error(err.detail ?? err.title ?? "Failed to load exports");
      }
    }
  }, [campaignId]);

  // Initial bootstrap of any in-flight or recent jobs.
  useEffect(() => {
    void refreshExports();
  }, [refreshExports]);

  // Poll while a job is active.
  useEffect(() => {
    if (!activeJob || (activeJob.status !== "pending" && activeJob.status !== "processing")) {
      pollAttemptsRef.current = 0;
      return;
    }
    let cancelled = false;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: polling tick interleaves cancellation, attempt cap, and terminal-status branching. Splitting it would force the cancellation flag through extra boundaries without simplifying the control flow.
    const tick = async () => {
      pollAttemptsRef.current += 1;
      if (pollAttemptsRef.current > JOB_POLL_MAX_ATTEMPTS) {
        toast.error("Export polling timed out — refresh the page to recheck.");
        return;
      }
      try {
        const next = await CampaignService.getExport(
          createClientApiClient(),
          campaignId,
          activeJob.id,
        );
        if (cancelled) return;
        setActiveJob(next);
        if (next.status === "completed" || next.status === "failed") {
          setPreviousJobs((p) => [next, ...p].slice(0, 5));
          if (next.status === "completed") {
            toast.success("Postal export ready — click Download to save the archive.");
          } else {
            toast.error(`Export failed: ${next.error ?? "unknown error"}`);
          }
        }
      } catch (err) {
        if (err instanceof ApiProblem) {
          toast.error(err.detail ?? err.title ?? "Polling failed");
        }
      }
    };
    const id = window.setInterval(tick, JOB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeJob, campaignId]);

  // Search constituents to attach (debounced).
  useEffect(() => {
    if (!isAdding) {
      setSearchResults([]);
      return;
    }
    const term = searchTerm.trim();
    const handle = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const result = await ConstituentService.listConstituents(createClientApiClient(), {
          search: term || undefined,
          perPage: 20,
        });
        const linkedIds = new Set(linked.map((l) => l.constituentId));
        setSearchResults(
          result.data
            .filter((c) => !linkedIds.has(c.id))
            .map((c) => ({
              id: c.id,
              firstName: c.firstName,
              lastName: c.lastName,
              email: c.email,
            })),
        );
      } catch (err) {
        if (err instanceof ApiProblem) {
          toast.error(err.detail ?? err.title ?? "Search failed");
        }
      } finally {
        setSearchLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [isAdding, searchTerm, linked]);

  const handleAttach = useCallback(
    async (id: string) => {
      try {
        await CampaignService.attachConstituents(createClientApiClient(), campaignId, [id]);
        toast.success("Recipient attached");
        await refreshLinked();
      } catch (err) {
        if (err instanceof ApiProblem) {
          toast.error(err.detail ?? err.title ?? "Failed to attach");
        }
      }
    },
    [campaignId, refreshLinked],
  );

  const handleDetach = useCallback(
    async (constituentId: string) => {
      try {
        await CampaignService.detachConstituent(createClientApiClient(), campaignId, constituentId);
        toast.success("Recipient removed");
        await refreshLinked();
      } catch (err) {
        if (err instanceof ApiProblem) {
          toast.error(err.detail ?? err.title ?? "Failed to remove");
        }
      }
    },
    [campaignId, refreshLinked],
  );

  const startExport = useCallback(
    async (mode: "door_drop" | "nominative") => {
      try {
        const job = await CampaignService.createExport(createClientApiClient(), campaignId, mode);
        setActiveJob(job);
        toast.success("Export queued — progress will update below.");
      } catch (err) {
        if (err instanceof ApiProblem) {
          toast.error(err.detail ?? err.title ?? "Failed to start export");
        }
      }
    },
    [campaignId],
  );

  const previewHref = useMemo(
    () =>
      `/api${CampaignService.previewPdfPath(campaignId, isDoorDrop ? "door_drop" : "nominative")}`,
    [campaignId, isDoorDrop],
  );

  if (isDigital) {
    // Digital campaigns don't ship postal letters — surface nothing rather
    // than a CTA that would 400 on click.
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileArchive size={18} aria-hidden="true" />
          Postal mailing
        </CardTitle>
        <CardDescription>
          Generate a print-ready PDF archive with QR codes for every recipient. Preview the letter
          layout before kicking off a mass export.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="secondary" size="sm">
            <a href={previewHref} target="_blank" rel="noopener noreferrer">
              <Eye size={16} aria-hidden="true" />
              Preview PDF (sample data)
            </a>
          </Button>
          {isDoorDrop ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void startExport("door_drop")}
              disabled={Boolean(activeJob)}
            >
              <FileArchive size={16} aria-hidden="true" />
              Generate door-drop archive
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void startExport("nominative")}
              disabled={Boolean(activeJob) || linkedTotal === 0}
            >
              <FileArchive size={16} aria-hidden="true" />
              Generate ZIP for {linkedTotal} recipient{linkedTotal === 1 ? "" : "s"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshExports()}
            aria-label="Refresh export jobs"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
        </div>

        {activeJob ? (
          <ExportJobBanner job={activeJob} />
        ) : previousJobs.length > 0 ? (
          <ExportHistory jobs={previousJobs} />
        ) : null}

        {isNominative ? (
          <RecipientList
            linked={linked}
            linkedTotal={linkedTotal}
            isAdding={isAdding}
            searchTerm={searchTerm}
            searchResults={searchResults}
            searchLoading={searchLoading}
            onSearchTermChange={setSearchTerm}
            onAddingChange={setIsAdding}
            onAttach={handleAttach}
            onDetach={handleDetach}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExportJobBanner({ job }: { job: CampaignExportJob }) {
  const pct = job.progressPct;
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          <p className="text-sm text-on-surface">
            {job.status === "pending" ? "Queued…" : "Generating archive"} ({job.progressDone} /{" "}
            {job.progressTotal})
          </p>
        </div>
        <span className="font-mono text-sm tabular-nums text-on-surface-variant">{pct}%</span>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-md bg-surface-container-highest"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Postal export progress: ${pct}%`}
      >
        <div
          className="h-full rounded-md bg-secondary transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ExportHistory({ jobs }: { jobs: CampaignExportJob[] }) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
      <p className="mb-2 text-sm font-medium text-on-surface">Recent exports</p>
      <ul className="space-y-2">
        {jobs.map((job) => (
          <li
            key={job.id}
            className="flex items-center justify-between gap-3 text-sm text-on-surface-variant"
          >
            <span className="truncate">
              {new Date(job.completedAt ?? job.updatedAt).toLocaleString()} —{" "}
              {job.mode === "door_drop" ? "Door-drop" : "Nominative"} (
              {job.status === "completed" ? `${job.progressDone} files` : job.status})
            </span>
            {job.status === "completed" && job.downloadUrl ? (
              <Button asChild variant="ghost" size="sm">
                <a href={job.downloadUrl}>
                  <Download size={14} aria-hidden="true" />
                  Download
                </a>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RecipientListProps {
  linked: LinkedConstituentRow[];
  linkedTotal: number;
  isAdding: boolean;
  searchTerm: string;
  searchResults: Array<{ id: string; firstName: string; lastName: string; email: string | null }>;
  searchLoading: boolean;
  onSearchTermChange: (value: string) => void;
  onAddingChange: (value: boolean) => void;
  onAttach: (id: string) => void;
  onDetach: (constituentId: string) => void;
}

function RecipientList({
  linked,
  linkedTotal,
  isAdding,
  searchTerm,
  searchResults,
  searchLoading,
  onSearchTermChange,
  onAddingChange,
  onAttach,
  onDetach,
}: RecipientListProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-on-surface">
          <Users size={14} className="mr-1 inline" aria-hidden="true" />
          Recipients ({linkedTotal})
        </p>
        <Button variant="ghost" size="sm" onClick={() => onAddingChange(!isAdding)}>
          {isAdding ? "Done" : "Add recipients"}
        </Button>
      </div>

      {isAdding ? (
        <div className="space-y-2 rounded-xl border border-outline-variant bg-surface-container-low p-3">
          <Input
            value={searchTerm}
            onChange={(e) => onSearchTermChange(e.target.value)}
            placeholder="Search constituents by name or email…"
            aria-label="Search constituents"
          />
          <div className="max-h-64 overflow-y-auto">
            {searchLoading ? (
              <p className="px-2 py-3 text-sm text-on-surface-variant">Searching…</p>
            ) : searchResults.length === 0 ? (
              <p className="px-2 py-3 text-sm text-on-surface-variant">
                No matches — try a different search term.
              </p>
            ) : (
              <ul>
                {searchResults.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-surface-container"
                  >
                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        {c.firstName} {c.lastName}
                      </p>
                      {c.email ? (
                        <p className="text-xs text-on-surface-variant">{c.email}</p>
                      ) : null}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => onAttach(c.id)}>
                      Attach
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {linked.length === 0 ? (
        <p className="rounded-xl border border-dashed border-outline-variant bg-surface-container-low px-4 py-6 text-center text-sm text-on-surface-variant">
          No recipients yet. Click <strong>Add recipients</strong> to build the mailing list.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant rounded-xl border border-outline-variant">
          {linked.slice(0, 25).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className="font-medium text-on-surface">
                  {row.firstName} {row.lastName}
                </p>
                <p className="text-xs text-on-surface-variant">
                  {row.email ?? "no email"}
                  {row.reconciledDonationCount > 0 ? (
                    <>
                      {" · "}
                      <span className="font-mono tabular-nums">
                        {(row.reconciledAmountCents / 100).toFixed(2)} reconciled
                      </span>{" "}
                      ({row.reconciledDonationCount} gift
                      {row.reconciledDonationCount === 1 ? "" : "s"})
                    </>
                  ) : null}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDetach(row.constituentId)}
                aria-label={`Remove ${row.firstName} ${row.lastName}`}
              >
                Remove
              </Button>
            </li>
          ))}
          {linked.length > 25 ? (
            <li className="px-4 py-2 text-center text-xs text-on-surface-variant">
              … and {linkedTotal - 25} more
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
