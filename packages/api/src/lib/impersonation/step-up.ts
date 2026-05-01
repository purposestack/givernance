/**
 * Step-up authentication checks for POST /admin/impersonation.
 *
 * The operator's access token must be (a) freshly minted via re-auth
 * (`auth_time` within the step-up window) and (b) optionally MFA-backed
 * (`acr >= 2`). Keycloak emits both claims natively for any client whose
 * default scopes include `acr` — see `realm-givernance.json` where the
 * `givernance-web` client already lists "acr" in `defaultClientScopes`.
 *
 * We deliberately do NOT implement an app-side TOTP secret store. Keycloak
 * IS the MFA authority; storing TOTP secrets in our DB would duplicate the
 * source of truth and create a parallel rotation/recovery surface that the
 * security team would have to maintain.
 */

import { env } from "../../env.js";

/** Window during which a re-auth counts as fresh. Spec doc §8 says step-up is required at session start. */
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
 * `acr` requirement defaults to `IMPERSONATION_REQUIRE_ACR_2` (false in
 * dev, MUST be true in production — env.ts hard-fails otherwise). We
 * accept both the string `"2"` and the integer-y `2` Keycloak occasionally
 * emits depending on broker settings.
 */
export function validateStepUp(claims: { auth_time?: unknown; acr?: unknown }): StepUpResult {
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : null;
  if (authTime === null) {
    return { ok: false, reason: "no_auth_time" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - authTime;
  if (age > STEP_UP_AUTH_TIME_WINDOW_SECONDS) {
    return { ok: false, reason: "auth_time_stale", ageSeconds: age };
  }

  const acrRaw = claims.acr;
  const acrStr = acrRaw === undefined || acrRaw === null ? null : String(acrRaw);

  if (env.IMPERSONATION_REQUIRE_ACR_2) {
    const numeric = acrStr ? Number.parseInt(acrStr, 10) : Number.NaN;
    if (Number.isNaN(numeric) || numeric < 2) {
      return { ok: false, reason: "acr_insufficient", acr: acrStr };
    }
  }

  return { ok: true, acr: acrStr };
}
