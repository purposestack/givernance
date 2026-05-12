import { validateTenantSlug } from "@givernance/shared/validators";

export type LoginHintResult =
  | { kind: "absent" }
  | { kind: "valid"; slug: string }
  | { kind: "rejected"; reason: "syntax" | "reserved" | "punycode" };

/**
 * Validate the optional `?hint=<slug>` parameter on `GET /api/auth/login`
 * (issue #150). The signup-verify and invite-accept pages forward the
 * tenant slug so the downstream Keycloak request can carry it as
 * `kc_idp_hint`, routing federated tenants straight to their IdP.
 *
 * Delegates to the canonical `validateTenantSlug` (`@givernance/shared/
 * validators`) so the shape rules — regex, length, `xn--` punycode
 * reject, reserved-slug list — stay in one place. PR #358 multi-agent
 * review M7 caught that the original local regex skipped the punycode
 * and reserved-slug checks, allowing `xn--paypal` / `admin` to reach
 * Keycloak as a `kc_idp_hint` value (low blast radius — KC ignores
 * unmatched aliases — but worth keeping the surface tight).
 *
 * Returns a discriminated result so the route can distinguish "no
 * hint provided" (silent) from "hint rejected" (worth a warn log so
 * probes are visible on Cockpit — review m2). Anti-injection is
 * already handled by `URLSearchParams.set` at the call site.
 */
export function validateLoginHint(raw: string | null | undefined): LoginHintResult {
  if (!raw || raw.trim() === "") return { kind: "absent" };
  const result = validateTenantSlug(raw);
  if (result.ok) return { kind: "valid", slug: result.slug };
  return { kind: "rejected", reason: result.reason };
}
