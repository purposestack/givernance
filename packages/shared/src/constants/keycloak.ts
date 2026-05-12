/**
 * Keycloak realm + client constants shared across the api, web, and worker
 * packages. The realm is provisioned by `infra/keycloak/realm-givernance.json`
 * and any rename here is load-bearing for OIDC audience validation, post-
 * logout redirect allowlists, and the back-channel logout endpoint
 * (issue #76 / PR-2).
 *
 * Reviewers caught four hardcoded `"givernance-web"` defaults across
 * `packages/api/src/env.ts`, `packages/web/src/lib/auth/keycloak.ts`,
 * `packages/web/src/proxy.ts`, and one `(auth)` route. Centralising the
 * default here keeps the env-override path working while collapsing the
 * drift surface to a single string.
 */

export const KEYCLOAK_DEFAULT_CLIENT_ID = "givernance-web";
