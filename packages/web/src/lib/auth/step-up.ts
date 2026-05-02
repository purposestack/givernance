/**
 * Step-up MFA redirect URL builder (issue #250).
 *
 * The impersonation form keys off the API's 401 `step_up_required: true`
 * response and sends the operator through `/api/auth/login` with
 * `acr_values=2` + `prompt=login`. The login route forwards both to
 * Keycloak (server-side allow-list), persists `return_to` in a 5-min
 * httpOnly cookie, and the callback redirects there after a successful
 * MFA-backed re-auth.
 *
 * Centralised here (vs inline in the form) so the URL shape is unit-
 * testable without spinning up the whole form + its pickers + a mocked
 * API surface.
 */

/**
 * Build the URL the browser should `window.location.assign` to so the
 * operator gets sent through Keycloak step-up and lands back at
 * `returnTo` afterwards. `returnTo` MUST be a same-origin path —
 * validated again server-side so a tampered call here can't open-redirect.
 */
export function buildStepUpRedirectUrl(origin: string, returnTo: string): string {
  const url = new URL("/api/auth/login", origin);
  url.searchParams.set("acr_values", "2");
  url.searchParams.set("prompt", "login");
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}

/**
 * Discriminator for the API's 401 step-up response shape — the body the
 * web side keys off. Aliased so the form (and any future caller) can
 * import a single type instead of duplicating the field set.
 */
export interface StepUpRequiredResponse {
  reason?: string;
  step_up_required?: boolean;
  detail?: string;
  title?: string;
}
