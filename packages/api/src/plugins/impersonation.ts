/**
 * Impersonation plugin (issue #24).
 *
 * Runs after the auth plugin. Both modes — `delegation` and pure
 * `impersonation` — produce a JWT whose `realm_access.roles` and `role`
 * claims drive normal RBAC; that's the entire permission story:
 *
 *   - **Mode `delegation`**     — operator's super_admin retained in
 *     `realm_access.roles[]`. Existing route guards (`requireSuperAdmin`,
 *     `requireWrite`, etc.) accept the call as if the operator were
 *     authenticated normally, which is the whole point of delegation
 *     ("droits étendus si nécessaire").
 *   - **Mode `impersonation`**  — operator's super_admin stripped; JWT
 *     carries the target user's roles only. Route guards now treat the
 *     request as if the target user themselves were calling, which is
 *     what makes bug-reproduction faithful: if the target can write, the
 *     operator can write *as them*; if the target gets a 403, so does
 *     the operator.
 *
 * The double-attribution audit trail (every row carries
 * `impersonation_session_id`, `impersonation_mode`, `actor_id` ≠
 * `user_id`) is what makes this safe — every write is provably
 * attributable to the operator who initiated the session.
 *
 * This plugin therefore does NOT add any extra permission checks beyond
 * what the auth plugin and the per-route guards already do. It exists as
 * a registration shell so future cross-cutting needs (e.g. emitting an
 * `impersonation.write` audit row at the request boundary) have a
 * natural home, without scattering impersonation-aware logic across the
 * route modules.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

async function impersonation(_app: FastifyInstance) {
  // Intentionally empty — RBAC + double-attribution audit cover both modes.
  // Earlier iterations introduced a default-deny write block on pure
  // impersonation, but that broke the very use case the mode exists for
  // (reproducing write-side bugs). Issue #24 acceptance criterion:
  // "impersonation = permissions du user cible uniquement".
}

export const impersonationPlugin = fp(impersonation, {
  name: "impersonation",
  dependencies: ["auth"],
});
