import { TENANT_SLUG_PATTERN } from "@givernance/shared/validators";

const SLUG_REGEX = new RegExp(TENANT_SLUG_PATTERN);

/**
 * Validate the optional `?hint=<slug>` parameter on `GET /api/auth/login`
 * (issue #150). The signup-verify and invite-accept pages forward the
 * tenant slug so the downstream Keycloak request can carry it as
 * `kc_idp_hint`, routing federated tenants straight to their IdP.
 *
 * Returns the canonical (trimmed + lowercased) slug on success, or
 * `null` when the value is absent or fails the tenant-slug shape — same
 * pattern enforced server-side on signup, so a hint that wouldn't be a
 * valid tenant slug is dropped instead of forwarded to Keycloak.
 *
 * Anti-injection: KC's `kc_idp_hint` is matched against configured IdP
 * aliases. An attacker can't trigger arbitrary KC behaviour from a
 * crafted hint because the value is wrapped by `URLSearchParams.set`
 * (no separator smuggling), but rejecting non-slug shapes early keeps
 * the upstream request log tight and prevents probing for unintended
 * alias matches.
 */
export function validateLoginHint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalised = raw.trim().toLowerCase();
  if (!SLUG_REGEX.test(normalised)) return null;
  return normalised;
}
