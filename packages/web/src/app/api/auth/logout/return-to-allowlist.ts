/**
 * Allowlist of safe `return_to` paths for `POST /api/auth/logout`.
 *
 * Prevents open-redirect by restricting the post-logout destination to
 * known in-app routes that benefit from a round-trip — e.g. accept-style
 * flows where the invitee may have arrived while another user was
 * signed in. The route handler exact-matches `parsed.pathname` against
 * this set; anything else falls back to `/login`.
 *
 * Lives in its own module (rather than `route.ts`) so unit tests can
 * import it without pulling Next.js's server-only imports
 * (`next/headers`, `next/server`).
 */
export const RETURN_TO_PATH_ALLOWLIST = new Set<string>([
  // PR #154: team invitation accept flow.
  "/invite/accept",
  // Issue #254: platform-admin invitation accept flow. The session-
  // conflict prompt round-trips through this allowlist after sign-out
  // so the invitee lands back on the password-set form (not /login).
  "/admin/platform-admins/accept",
]);
