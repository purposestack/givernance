/**
 * F2 — Allowlist of Keycloak Organization attribute keys that Givernance
 * code may set. The realm's `organization` client scope is wired with
 * `oidc-organization-membership-mapper` configured with
 * `addOrganizationAttributes: true`, which emits **every** Organization
 * attribute into the access / ID / introspection JWT of every member of
 * that org. The mapper has no per-key filter, so the only line of defence
 * is what our code chooses to write.
 *
 * Hoisted to `@givernance/shared/constants` so the api and worker copies
 * stay in lockstep — a developer adding `theme_secondary_color` shouldn't
 * be able to land it on one side and silently leave the other side
 * rejecting (which would surface as a confusing branding-sync error in
 * prod, not as a security regression).
 *
 * Pure constants only — no runtime deps — so this stays inside ADR-013's
 * type-boundary rules for `@givernance/shared`.
 */

export const SAFE_ORG_ATTRIBUTES: ReadonlySet<string> = new Set([
  // Canonical tenant id — already emitted as a designated JWT claim by the
  // `oidc-usermodel-attribute-mapper`. Mirrored on the org so we can find
  // a half-created org by id during recovery (signup verify 409 path).
  "org_id",
  // Tenant slug — public (it's in the URL). Set by
  // `tenant-admin.createOrganization`. Kept on the allowlist for
  // explicitness rather than because exclusion would matter.
  "org_slug",
  // Public branding rendered on the Keycloak login template. Epic #286.
  "logo_url",
  // Public branding rendered on the Keycloak login template. Epic #286.
  "theme_primary_color",
]);

export function assertSafeOrgAttributes(attributes: Record<string, string[]> | undefined): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    if (!SAFE_ORG_ATTRIBUTES.has(key)) {
      throw new Error(
        `Refusing to write Keycloak Organization attribute "${key}" — not in SAFE_ORG_ATTRIBUTES. ` +
          `The realm's organization mapper emits every attribute into every member's JWT; ` +
          `add this key to SAFE_ORG_ATTRIBUTES (packages/shared/src/constants/keycloak-org-attributes.ts) ` +
          `only after confirming it is safe to leak to all browsers.`,
      );
    }
  }
}
