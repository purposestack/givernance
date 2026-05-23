"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";
import { buildStepUpRedirectUrl, type StepUpRequiredResponse } from "@/lib/auth/step-up";
import type { ImpersonationModeName } from "@/lib/auth/verify-impersonation-jwt";
import type { ImpersonationTargetCandidate } from "@/services/ImpersonationService";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const IMPERSONATION_REASON_MAX_LENGTH = 2000;
const REPLICATED_MARKER = " (replicated)";

/**
 * Same sessionStorage key + 5-minute TTL the start-form uses
 * (`packages/web/src/components/admin/start-impersonation-form.tsx`).
 * The Replicate flow piggy-backs on the form's post-MFA Resume banner:
 * if the API responds `step_up_required`, we stash the payload here,
 * bounce through `/api/auth/login?acr_values=2&return_to=
 * /admin/impersonation/new`, and the start-form hydrates from the
 * stash on bounce-back so the operator only has to click "Resume".
 * Sharing the constant inline (not exporting it from the form) keeps
 * the form's pre-existing private contract intact; the duplicated
 * literal is the price of not coupling the two surfaces.
 */
const STASH_KEY = "gv-impersonation-resubmit";
const STASH_TTL_MS = 5 * 60 * 1000;

/**
 * Append the " (replicated)" marker to the reason field unless it's
 * already there (idempotent across multi-hop replicate). Skip the
 * append when it would push the field past the 2000-char API cap —
 * in that rare case the rebroadcast still works, just without the
 * audit-clarity marker. The reason in `audit_logs` (and the new
 * `impersonation_sessions` row) will read exactly this string.
 */
function markReplicated(reason: string): string {
  if (reason.endsWith(REPLICATED_MARKER)) return reason;
  if (reason.length + REPLICATED_MARKER.length > IMPERSONATION_REASON_MAX_LENGTH) return reason;
  return reason + REPLICATED_MARKER;
}

/**
 * The four possible non-success outcomes the API can return for a
 * Replicate POST. Each variant is what `onClick` should *do* — not
 * what the API said — so the click handler reduces to a switch on
 * the outcome instead of re-branching on `res.status` and
 * `body.step_up_required`. Extracted to keep `onClick` under Biome's
 * cognitive-complexity budget (per `feedback_warnings_become_errors`).
 */
type ReplicateErrorOutcome =
  | { kind: "redirect-step-up"; reason: string }
  | { kind: "error"; message: string };

function resolveErrorOutcome(
  res: Response,
  body: StepUpRequiredResponse,
  reason: string,
  t: ReturnType<typeof useTranslations>,
): ReplicateErrorOutcome {
  if (res.status === 401 && body.step_up_required) {
    return { kind: "redirect-step-up", reason };
  }
  if (res.status === 401 && body.step_up_required === false) {
    return { kind: "error", message: t("errorLockout") };
  }
  if (res.status === 401) {
    return { kind: "error", message: t("errorStepUpFailed") };
  }
  return {
    kind: "error",
    message: body.detail ?? body.title ?? `Request failed: ${res.status}`,
  };
}

interface ReplicateImpersonationSessionButtonProps {
  /** App `users.id` of the target — already filtered for non-null by the parent. */
  targetUserId: string;
  /** Same enum the start endpoint accepts ("delegation" | "impersonation"). */
  mode: ImpersonationModeName;
  /** Original reason; will be appended with " (replicated)" before send. */
  reason: string;
  /** Identifier fields used to rebuild a target candidate for the post-MFA stash. */
  targetKeycloakId: string;
  targetOrgId: string;
  targetRole: string;
  targetFirstName: string | null;
  targetLastName: string | null;
  targetEmail: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
}

/**
 * One-click Replicate for a past impersonation session (issue #428).
 *
 * Click → POST `/v1/admin/impersonation` with the original session's
 * target / mode / reason (+ " (replicated)" marker). Outcomes:
 *
 *   - 201 → API set the impersonation cookie; navigate to /dashboard
 *     (mirrors the start-form happy path).
 *   - 401 + step_up_required=true → stash payload + bounce through
 *     /api/auth/login?acr_values=2&return_to=/admin/impersonation/new
 *     so the start-form's Resume banner picks up where we left off.
 *   - 401 + step_up_required=false → 5-fail lockout engaged; render
 *     inline error.
 *   - 4xx (other) → render API's RFC 9457 detail inline.
 *
 * The button is hidden by the parent when the flag is off or when
 * `targetUserId` is null (off-boarded target — Replicate has no app
 * `users.id` to send).
 */
export function ReplicateImpersonationSessionButton(
  props: ReplicateImpersonationSessionButtonProps,
) {
  const t = useTranslations("admin.impersonation");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function stashForResume(reason: string): void {
    // Rebuild the candidate shape the start-form expects. Fall back to
    // empty strings on null enrichment fields — the new-form Resume
    // banner only uses these for display; the load-bearing field for
    // the POST is `id` (= app users.id).
    const target: ImpersonationTargetCandidate = {
      id: props.targetUserId,
      firstName: props.targetFirstName ?? "",
      lastName: props.targetLastName ?? "",
      email: props.targetEmail ?? "",
      role: props.targetRole,
      keycloakId: props.targetKeycloakId,
      tenantId: props.targetOrgId,
      tenantName: props.tenantName ?? "",
      tenantSlug: props.tenantSlug ?? "",
    };
    try {
      sessionStorage.setItem(
        STASH_KEY,
        JSON.stringify({
          target,
          mode: props.mode,
          reason,
          expiresAt: Date.now() + STASH_TTL_MS,
        }),
      );
    } catch {
      // Privacy mode / quota — fall through; the bounce-back form will
      // just be empty and the operator picks up via the start-form
      // pickers.
    }
  }

  async function onClick() {
    setError(null);
    setSubmitting(true);
    const reason = markReplicated(props.reason);
    let willNavigate = false;
    try {
      const csrf = readCsrfTokenFromDocumentCookie();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrf) headers[getCsrfHeaderName()] = csrf;

      const res = await fetch(`${API_URL}/v1/admin/impersonation`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          targetUserId: props.targetUserId,
          mode: props.mode,
          reason,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as StepUpRequiredResponse;
        const outcome = resolveErrorOutcome(res, body, reason, t);
        if (outcome.kind === "redirect-step-up") {
          stashForResume(outcome.reason);
          willNavigate = true;
          setError(t("stepUpRedirecting"));
          window.location.assign(
            buildStepUpRedirectUrl(window.location.origin, "/admin/impersonation/new"),
          );
          return;
        }
        setError(outcome.message);
        return;
      }

      // Fresh impersonation cookie scoped to the target tenant — drop
      // into the target's dashboard exactly as the start-form does.
      willNavigate = true;
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      if (!willNavigate) setSubmitting(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="ghost" onClick={onClick} disabled={submitting}>
        {submitting ? t("replicating") : t("replicate")}
      </Button>
      {error && (
        <span className="text-xs text-error-text" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
