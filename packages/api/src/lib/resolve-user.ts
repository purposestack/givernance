/**
 * Resolve the internal `users.id` for a JWT subject within a tenant.
 *
 * `request.auth.userId` is the JWT `sub` claim (= `users.keycloak_id`),
 * NOT the internal UUID. Inserting it directly into a column that FKs
 * `users.id` (e.g. `campaign_postal_exports.requested_by`,
 * `campaign_constituents.added_by`) trips the FK constraint because
 * Keycloak ids and internal `users.id` live in independent UUID spaces.
 *
 * The integration suite's auth fixture (`tests/helpers/auth.ts`) seeds
 * `users.id == users.keycloak_id` for synthetic test subjects, which
 * masked this divergence in CI. The real Demo NPO seed
 * (`scripts/seed.ts`) uses `defaultRandom()` for `users.id`, so the FK
 * fails on first try in dev / staging / prod against an actual user.
 *
 * Returns `null` when the subject does not match an active member of the
 * tenant — typical when an impersonating platform admin acts in pure-
 * impersonation mode against a tenant they don't belong to. Callers
 * should write `null` into the FK column; double-attribution audit
 * (actor_id + impersonation_session_id) still captures the real actor.
 */

import { users } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { withTenantContext } from "./db.js";

export async function resolveInternalUserId(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  keycloakSub: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.keycloakId, keycloakSub), isNull(users.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}
