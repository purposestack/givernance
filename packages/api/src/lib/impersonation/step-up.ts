/**
 * Step-up authentication checks for POST /admin/impersonation.
 *
 * Conceptually step-up = "the operator just re-authenticated, with MFA when
 * the realm has it configured." Two claims combine to express that:
 *
 *   - `acr >= 2`     — the new login was MFA-backed.
 *   - `auth_time`    — the original authentication is recent enough that
 *                       we trust the session.
 *
 * Both checks act in lockstep: the auth_time freshness window is a
 * proxy for "how long since the last MFA challenge," so it only adds
 * security WHEN MFA is required. Decoupling the two — fresh auth_time
 * but no MFA — is theatre, not security; and in dev where MFA is off
 * entirely, it just produces a dead-end UX where every retry after the
 * first 5 minutes 401s with no operator-actionable next step.
 *
 * We deliberately do NOT implement an app-side TOTP secret store —
 * Keycloak IS the MFA authority.
 */

import { env } from "../../env.js";

/** Window during which a re-auth counts as fresh. Doc-19 §7 — step-up is required at session start. */
export const STEP_UP_AUTH_TIME_WINDOW_SECONDS = 5 * 60;

export type StepUpFailureReason = "no_auth_time" | "auth_time_stale" | "acr_insufficient";

export interface StepUpResult {
  ok: boolean;
  reason?: StepUpFailureReason;
  /** Distance the auth_time was outside the window (seconds), for logging. */
  ageSeconds?: number;
  /** Actual ACR string from the JWT, for logging. */
  acr?: string | null;
}

/**
 * Validate the step-up claims surfaced by Keycloak.
 *
 * The `auth_time` freshness check is GATED on `requireAcr2`: when MFA
 * is not required (dev / low-security envs), `auth_time` is just a
 * proxy that doesn't add security and creates a dead-end UX. When MFA
 * IS required (production), both checks fire — fresh auth_time +
 * acr ≥ 2 = "operator just re-authenticated with MFA," which is the
 * actual step-up promise.
 *
 * The `requireAcr2` flag defaults to the env-derived value so the route
 * handler can call this with no args; tests pass it explicitly.
 */
export function validateStepUp(
  claims: { auth_time?: unknown; acr?: unknown },
  requireAcr2: boolean = env.IMPERSONATION_REQUIRE_ACR_2,
): StepUpResult {
  const acrRaw = claims.acr;
  const acrStr = acrRaw === undefined || acrRaw === null ? null : String(acrRaw);

  // Low-security / dev path — no MFA requirement, no freshness gate.
  // The session-start endpoint still enforces RBAC (super_admin), the
  // 24h rate limit, and the 5-fail lockout, so this isn't a free-for-all.
  if (!requireAcr2) {
    return { ok: true, acr: acrStr };
  }

  // Production / MFA-required path — both gates fire together.
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : null;
  if (authTime === null) {
    return { ok: false, reason: "no_auth_time" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - authTime;
  if (age > STEP_UP_AUTH_TIME_WINDOW_SECONDS) {
    return { ok: false, reason: "auth_time_stale", ageSeconds: age };
  }

  const numeric = acrStr ? Number.parseInt(acrStr, 10) : Number.NaN;
  if (Number.isNaN(numeric) || numeric < 2) {
    return { ok: false, reason: "acr_insufficient", acr: acrStr };
  }

  return { ok: true, acr: acrStr };
}
