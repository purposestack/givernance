"use client";

/**
 * SurveyLaunchCard — manual super-admin control to launch PMF / NPS /
 * CSAT surveys outside the StaleBanner cadence (issue #444).
 *
 * Background: the backend (worker + endpoints) is fully shipped by
 * Epic #434 / issue #437. Until this card landed, the only way to
 * force-send an invitation was via the StaleBanner (which only shows
 * when data is past its freshness threshold) or by curling the
 * endpoint by hand. A super-admin wanting an off-cadence pulse (board
 * meeting prep, post-pricing-change sanity check, …) had no UI.
 *
 * The card is stateless about cooldowns: the server enforces the 24h
 * per-(survey, channel) lock and returns 429 + `Retry-After`. We
 * react to that response with a clear toast instead of trying to
 * pre-disable the buttons — the SurveyRow shape exposed by /summary
 * doesn't carry `last_launched_at`, so a client-side disable would
 * lie half the time. Server is the source of truth.
 *
 * Each launch click mints a fresh `crypto.randomUUID()` so a
 * retry-after-network-blip doesn't double-send: the API dedupes on
 * the Idempotency-Key but only as long as the (survey, channel)
 * payload matches.
 */

import { useLocale } from "next-intl";
import { useCallback, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiProblem } from "@/lib/api/problem";
import { formatDate } from "@/lib/format";
import type { SurveyCadence, SurveyKind, SurveyRow } from "@/models/superadmin-finance";

import { toast } from "./toast";

export interface SurveyLaunchCardLabels {
  /** Section heading shown above the grid of survey rows. */
  title: string;
  /** Short helper line under the heading. */
  subtitle: string;
  /** One label per survey kind — defaults to capitalised acronym. */
  pmfLabel: string;
  npsLabel: string;
  csatLabel: string;
  /** "X responses" plural form (ICU is fine; we pass {count}). */
  responseCount: (count: number) => string;
  /** "Last collected: {date}" / "No responses yet" copy. */
  lastCollectedAt: (date: string) => string;
  lastCollectedNever: string;
  /** "Next scheduled: {date}" / "No cadence set" copy. */
  nextScheduledAt: (date: string) => string;
  nextScheduledNever: string;
  /** Action button labels. */
  launchEmail: string;
  launchInApp: string;
  changeCadence: string;
  /** Toast copy. */
  toastLaunching: string;
  toastLaunched: (recipientCount: number) => string;
  toastCooldown: (retryAfterMinutes: number) => string;
  toastError: (detail: string) => string;
  /** Cadence dialog. */
  cadenceDialogTitle: (surveyLabel: string) => string;
  cadenceDialogBody: string;
  cadenceOptionQuarterly: string;
  cadenceOptionMonthly: string;
  cadenceOptionContinuous: string;
  cadenceDialogCancel: string;
  cadenceDialogConfirm: string;
  cadenceToastUpdated: string;
  cadenceToastError: (detail: string) => string;
}

export interface SurveyLaunchCardProps {
  surveys: SurveyRow[];
  labels: SurveyLaunchCardLabels;
  /** Returns the API success payload (recipientCount + launchedAt). */
  onLaunch: (
    slug: string,
    channel: "email" | "in_app",
    idempotencyKey: string,
  ) => Promise<{
    recipientCount: number;
  }>;
  /** Returns the API success payload (resolved cadence). */
  onSchedule: (slug: string, cadence: SurveyCadence) => Promise<void>;
}

interface PendingDialog {
  slug: string;
  label: string;
  current: SurveyCadence;
}

function defaultCadenceFor(kind: SurveyKind): SurveyCadence {
  // Match the docs/32 cadence defaults — CSAT runs continuously, the
  // satisfaction surveys default to quarterly-minus-7d.
  return kind === "csat" ? "continuous" : "quarterly_minus_7d";
}

function isApiProblem(err: unknown): err is ApiProblem {
  return err instanceof ApiProblem;
}

function errorDetail(err: unknown): string {
  if (isApiProblem(err)) return err.detail ?? err.title;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

function cooldownMinutesFrom(err: ApiProblem): number {
  const seconds =
    typeof err.extensions.retry_after_seconds === "number" ? err.extensions.retry_after_seconds : 0;
  return Math.max(1, Math.ceil(seconds / 60));
}

export function SurveyLaunchCard({ surveys, labels, onLaunch, onSchedule }: SurveyLaunchCardProps) {
  const headingId = useId();
  const locale = useLocale();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [dialogCadence, setDialogCadence] = useState<SurveyCadence>("quarterly_minus_7d");
  const [dialogBusy, setDialogBusy] = useState(false);

  const handleLaunch = useCallback(
    async (slug: string, channel: "email" | "in_app") => {
      const key = `${slug}:${channel}`;
      if (busyKey === key) return;
      setBusyKey(key);
      const toastId = toast.loading(labels.toastLaunching);
      try {
        const idempotencyKey = crypto.randomUUID();
        const result = await onLaunch(slug, channel, idempotencyKey);
        toast.success(labels.toastLaunched(result.recipientCount), { id: toastId });
      } catch (err) {
        if (isApiProblem(err) && err.status === 429) {
          toast.error(labels.toastCooldown(cooldownMinutesFrom(err)), { id: toastId });
        } else {
          toast.error(labels.toastError(errorDetail(err)), { id: toastId });
        }
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, labels, onLaunch],
  );

  const openCadenceDialog = useCallback((survey: SurveyRow, surveyLabel: string) => {
    setDialog({ slug: survey.slug, label: surveyLabel, current: defaultCadenceFor(survey.kind) });
    setDialogCadence(defaultCadenceFor(survey.kind));
  }, []);

  const closeDialog = useCallback(() => {
    if (dialogBusy) return;
    setDialog(null);
  }, [dialogBusy]);

  const confirmCadence = useCallback(async () => {
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    try {
      await onSchedule(dialog.slug, dialogCadence);
      toast.success(labels.cadenceToastUpdated);
      setDialog(null);
    } catch (err) {
      toast.error(labels.cadenceToastError(errorDetail(err)));
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, dialogCadence, dialogBusy, labels, onSchedule]);

  const kindLabel = useCallback(
    (kind: SurveyKind): string => {
      if (kind === "pmf") return labels.pmfLabel;
      if (kind === "nps") return labels.npsLabel;
      return labels.csatLabel;
    },
    [labels],
  );

  return (
    <section className="fin-card" aria-labelledby={headingId}>
      <div className="fin-card-header">
        <div>
          <h3 className="fin-card-title" id={headingId}>
            {labels.title}
          </h3>
          <div className="fin-card-subtitle">{labels.subtitle}</div>
        </div>
      </div>
      <ul className="survey-launch-list">
        {surveys.map((survey) => {
          const label = kindLabel(survey.kind);
          const emailKey = `${survey.slug}:email`;
          const inAppKey = `${survey.slug}:in_app`;
          return (
            <li key={survey.slug} className="survey-launch-row">
              <div className="survey-launch-row__meta">
                <div className="survey-launch-row__title">{label}</div>
                <div className="survey-launch-row__sub">
                  {labels.responseCount(survey.responseCount)}
                  {" · "}
                  {survey.lastCollectedAt
                    ? labels.lastCollectedAt(formatDate(survey.lastCollectedAt, locale, "medium"))
                    : labels.lastCollectedNever}
                  {" · "}
                  {survey.nextScheduledAt
                    ? labels.nextScheduledAt(formatDate(survey.nextScheduledAt, locale, "medium"))
                    : labels.nextScheduledNever}
                </div>
              </div>
              <div className="survey-launch-row__actions">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => handleLaunch(survey.slug, "email")}
                  disabled={busyKey === emailKey}
                  aria-busy={busyKey === emailKey}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
                    outgoing_mail
                  </span>
                  {labels.launchEmail}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => handleLaunch(survey.slug, "in_app")}
                  disabled={busyKey === inAppKey}
                  aria-busy={busyKey === inAppKey}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
                    notifications_active
                  </span>
                  {labels.launchInApp}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openCadenceDialog(survey, label)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
                    schedule
                  </span>
                  {labels.changeCadence}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog ? labels.cadenceDialogTitle(dialog.label) : labels.cadenceDialogTitle("")}
            </DialogTitle>
            <DialogDescription>{labels.cadenceDialogBody}</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label={labels.cadenceDialogBody} className="cadence-options">
            {(
              [
                ["quarterly_minus_7d", labels.cadenceOptionQuarterly],
                ["monthly", labels.cadenceOptionMonthly],
                ["continuous", labels.cadenceOptionContinuous],
              ] as const
            ).map(([value, optionLabel]) => (
              <label key={value} className="cadence-option">
                <input
                  type="radio"
                  name="cadence"
                  value={value}
                  checked={dialogCadence === value}
                  onChange={() => setDialogCadence(value)}
                />
                <span>{optionLabel}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              {labels.cadenceDialogCancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={confirmCadence}
              disabled={dialogBusy}
              aria-busy={dialogBusy}
            >
              {labels.cadenceDialogConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
