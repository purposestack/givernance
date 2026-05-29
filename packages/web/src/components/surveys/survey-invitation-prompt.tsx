"use client";

/**
 * SurveyInvitationPrompt — in-app survey delivery for the
 * `channel='in_app'` invitations created by issue #444.
 *
 * Mounted in the authenticated tenant layout so any logged-in tenant
 * user (NOT super-admin) sees a pending invitation the next time they
 * open the app. Fetches `GET /v1/surveys/pending` on mount + every 60s
 * (polling instead of SSE for v1 — keeps the surface area small;
 * Epic #363's outbox-fanout is the natural upgrade path).
 *
 * Three response shapes, picked by `surveyKind`:
 *  - pmf  → 3 radio options (very/somewhat/not disappointed)
 *  - nps  → 0-10 score grid
 *  - csat → 1-5 star rating
 *
 * The modal is non-blocking: the user can dismiss with "Not now" and
 * the invitation is settled (`dismissed_at = NOW()`) so the next
 * launch cadence is allowed to re-invite. Closing without clicking
 * "Not now" (e.g. Esc / outside-click) does NOT settle the
 * invitation — that's intentional, so an accidental close doesn't
 * burn the survey slot.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { createClientApiClient } from "@/lib/api/client-browser";
import { ApiProblem } from "@/lib/api/problem";
import {
  isSurveyResponseComplete,
  type PendingSurveyInvitation,
  type SurveyResponsePayload,
} from "@/models/surveys";
import { TenantSurveyService } from "@/services/TenantSurveyService";

const POLL_INTERVAL_MS = 60_000;

export function SurveyInvitationPrompt({ locale }: { locale: "fr" | "en" }) {
  const t = useTranslations("surveyPrompt");
  const [invitation, setInvitation] = useState<PendingSurveyInvitation | null>(null);
  const [response, setResponse] = useState<SurveyResponsePayload>({});
  const [submitting, setSubmitting] = useState(false);
  // Invitation IDs the user has Esc/outside-clicked away during this
  // page session. Without this, every poll would re-surface the same
  // invitation seconds after the user closed it — keeping it
  // pending server-side but invisible until the next page load /
  // refresh is the intended UX.
  const [suppressedIds, setSuppressedIds] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      const api = createClientApiClient();
      const pending = await TenantSurveyService.fetchPending(api);
      // Only swap in a new invitation if no modal is currently open —
      // otherwise the user's in-progress selection would flicker away
      // when the poll lands. Also skip anything the user has already
      // Esc'd away during this session.
      setInvitation((current) => {
        if (current) return current;
        return pending.find((p) => !suppressedIds.has(p.invitationId)) ?? null;
      });
    } catch {
      // Polling failure is non-fatal — try again on the next tick.
    }
  }, [suppressedIds]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const reset = useCallback(() => {
    setInvitation(null);
    setResponse({});
  }, []);

  // Soft-close: drop the modal locally + remember the ID so polling
  // doesn't re-pop it for the rest of the page session. Distinct from
  // `handleDismiss` (which POSTs /dismiss to settle server-side).
  const suppressLocally = useCallback(() => {
    if (!invitation) return;
    setSuppressedIds((s) => {
      const next = new Set(s);
      next.add(invitation.invitationId);
      return next;
    });
    reset();
  }, [invitation, reset]);

  const handleSubmit = useCallback(async () => {
    if (!invitation || submitting) return;
    if (!isSurveyResponseComplete(invitation.surveyKind, response)) {
      return;
    }
    setSubmitting(true);
    try {
      const api = createClientApiClient();
      await TenantSurveyService.respond(api, invitation.invitationId, { response });
      toast.success(t("toastSubmitted"));
      reset();
      // Chain into the next pending invitation if any — without this
      // the user has to wait up to 60s for the next poll (or refresh
      // the page) before seeing their next survey. Runs after
      // `reset()` cleared `invitation`, so the refresh's
      // `current ?? pending[0]` resolution picks the next one.
      await refresh();
    } catch (err) {
      const detail =
        err instanceof ApiProblem
          ? (err.detail ?? err.title)
          : err instanceof Error
            ? err.message
            : "Unknown error";
      toast.error(t("toastError", { detail }));
    } finally {
      setSubmitting(false);
    }
  }, [invitation, response, submitting, reset, refresh, t]);

  const handleDismiss = useCallback(async () => {
    if (!invitation || submitting) return;
    setSubmitting(true);
    try {
      const api = createClientApiClient();
      await TenantSurveyService.dismiss(api, invitation.invitationId);
      reset();
      // Same chaining as submit — dismiss settles the invitation
      // server-side (dismissed_at = NOW()), so the next /pending
      // returns the remaining ones.
      await refresh();
    } catch {
      // Dismiss-error is non-fatal — close locally so the user isn't
      // trapped if the request fails (the next poll re-evaluates).
      reset();
    } finally {
      setSubmitting(false);
    }
  }, [invitation, submitting, reset, refresh]);

  if (!invitation) return null;

  const question = locale === "fr" ? invitation.questionFr : invitation.questionEn;
  const canSubmit = isSurveyResponseComplete(invitation.surveyKind, response);

  // Esc / outside-click closes the modal LOCALLY only (resets the
  // in-component state). It does NOT POST /dismiss — the invitation
  // stays open server-side so the next page load / next poll surfaces
  // it again. Only the explicit "Not now" button settles the
  // invitation (sets dismissed_at + opened_at).
  return (
    <Dialog open onOpenChange={(open) => !open && suppressLocally()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{question}</DialogDescription>
        </DialogHeader>

        {invitation.surveyKind === "pmf" && (
          <div role="radiogroup" aria-label={t("pmfAriaLabel")} className="survey-prompt-options">
            {(
              [
                ["very_disappointed", t("pmfVeryDisappointed")],
                ["somewhat_disappointed", t("pmfSomewhatDisappointed")],
                ["not_disappointed", t("pmfNotDisappointed")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="survey-prompt-option">
                <input
                  type="radio"
                  name="pmf"
                  value={value}
                  checked={response.category === value}
                  onChange={() => setResponse({ category: value })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        )}

        {invitation.surveyKind === "nps" && (
          // Native <input type="radio"> via <label> gives us the
          // canonical ARIA radio-group keyboard model for free
          // (arrow-keys move selection + roving tabindex) and
          // satisfies biome's useSemanticElements lint. The visible
          // pill is rendered via CSS on the sibling span.
          <div className="survey-prompt-nps" role="radiogroup" aria-label={t("npsAriaLabel")}>
            {Array.from({ length: 11 }, (_, i) => i).map((n) => (
              <label key={n} className="survey-prompt-nps__option">
                <input
                  type="radio"
                  name="survey-nps"
                  value={n}
                  checked={response.score === n}
                  onChange={() => setResponse({ score: n })}
                />
                <span className={response.score === n ? "active" : ""}>{n}</span>
              </label>
            ))}
          </div>
        )}

        {invitation.surveyKind === "csat" && (
          <div className="survey-prompt-csat" role="radiogroup" aria-label={t("csatAriaLabel")}>
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className="survey-prompt-csat__option">
                <input
                  type="radio"
                  name="survey-csat"
                  value={n}
                  checked={response.rating === n}
                  onChange={() => setResponse({ rating: n })}
                />
                <span className={response.rating === n ? "active" : ""}>{n} ★</span>
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          {/* "Ignorer" settles the invitation server-side
              (dismissed_at + opened_at = NOW) — the user opts out
              for this entire cycle and will only see this survey
              again at the next cadence tick (90d for PMF/NPS). */}
          <Button type="button" variant="ghost" onClick={handleDismiss} disabled={submitting}>
            {t("dismiss")}
          </Button>
          {/* "Plus tard" is a session-local soft-close — no server
              call, just adds the invitation id to suppressedIds so
              the 60s poll doesn't re-pop it during this page
              session. Next login / page refresh surfaces it again,
              matching what "plus tard" actually implies. */}
          <Button type="button" variant="ghost" onClick={suppressLocally} disabled={submitting}>
            {t("notNow")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            aria-busy={submitting}
          >
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
