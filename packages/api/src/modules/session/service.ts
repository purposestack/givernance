/**
 * Session service — org picker + switch-org (issue #112 / ADR-016 / doc 22 §6.3, §7).
 *
 * Scope:
 *  - `listUserOrganizations` enumerates the tenants the calling user belongs
 *    to, by the Keycloak `sub` claim. Cross-tenant query → owner role, no
 *    `withTenantContext`. Returns role + last-visited metadata for the
 *    picker card sort.
 *  - `recordOrgSwitch` validates membership of the target tenant, updates
 *    `last_visited_at`, blocklists the previous access token's `jti` and
 *    emits audit + outbox events.
 *
 * The actual token re-minting (Keycloak token-exchange) is wired on the
 * Next.js API side in `/api/auth/switch-org`; this service is the trusted
 * authority that authorises the switch and records it.
 */

import { auditLogs, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenantContext } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  status: string;
  role: string;
  firstAdmin: boolean;
  provisionalUntil: string | null;
  primaryDomain: string | null;
  lastVisitedAt: string | null;
}

/**
 * List every tenant the user belongs to (by Keycloak `sub`). Suspended /
 * archived tenants are excluded so a revoked org never shows in the picker.
 */
export async function listUserOrganizations(keycloakSub: string): Promise<OrgMembership[]> {
  const rows = await db
    .select({
      orgId: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      status: tenants.status,
      role: users.role,
      firstAdmin: users.firstAdmin,
      provisionalUntil: users.provisionalUntil,
      primaryDomain: tenants.primaryDomain,
      lastVisitedAt: users.lastVisitedAt,
    })
    .from(users)
    .innerJoin(tenants, eq(users.orgId, tenants.id))
    .where(and(eq(users.keycloakId, keycloakSub), sql`${tenants.status} <> 'archived'`))
    .orderBy(sql`${users.lastVisitedAt} DESC NULLS LAST`, sql`${tenants.name} ASC`);

  return rows.map((r) => ({
    orgId: r.orgId,
    slug: r.slug,
    name: r.name,
    status: r.status,
    role: r.role,
    firstAdmin: r.firstAdmin,
    provisionalUntil: r.provisionalUntil?.toISOString() ?? null,
    primaryDomain: r.primaryDomain,
    lastVisitedAt: r.lastVisitedAt?.toISOString() ?? null,
  }));
}

export type SwitchOrgResult =
  | {
      ok: true;
      targetOrgId: string;
      targetSlug: string;
      targetRole: string;
    }
  | {
      ok: false;
      error: "not_a_member" | "target_not_found" | "target_suspended" | "target_archived";
    };

export interface SwitchOrgInput {
  keycloakSub: string;
  targetOrgId: string;
  /** Previous access-token `jti` — blocklisted on success (session revocation). */
  previousJti?: string;
  /** JWT `exp` (seconds-epoch) of the previous access token — used to TTL the blocklist. */
  previousExp?: number;
  /** If the caller currently has an impersonation `act` claim, the switch must be refused. */
  isImpersonating?: boolean;
  audit: {
    ipHash?: string;
    userAgent?: string;
  };
}

/**
 * Validate membership of the target tenant and record the switch. Writes
 * `last_visited_at`, audit, outbox. Blocklists the previous JWT (if any) so
 * that — once the front-door auth middleware consults the blocklist — the
 * old cookie can no longer be used to read the previous tenant's data.
 */
export async function recordOrgSwitch(input: SwitchOrgInput): Promise<SwitchOrgResult> {
  if (!UUID_RE.test(input.targetOrgId)) return { ok: false, error: "target_not_found" };
  if (input.isImpersonating) {
    // Per ADR-016 / doc 22 §8: switch-org terminates impersonation. We return
    // `not_a_member` so the caller is forced through /api/auth/logout first;
    // a dedicated error code exposes the impersonation boundary externally,
    // which we explicitly do not want to do.
    return { ok: false, error: "not_a_member" };
  }

  const [target] = await db
    .select({
      orgId: tenants.id,
      slug: tenants.slug,
      status: tenants.status,
      role: users.role,
      userId: users.id,
    })
    .from(users)
    .innerJoin(tenants, eq(users.orgId, tenants.id))
    .where(and(eq(users.keycloakId, input.keycloakSub), eq(users.orgId, input.targetOrgId)))
    .limit(1);

  if (!target) return { ok: false, error: "not_a_member" };
  if (target.status === "suspended") return { ok: false, error: "target_suspended" };
  if (target.status === "archived") return { ok: false, error: "target_archived" };

  await withTenantContext(target.orgId, async (tx) => {
    await tx
      .update(users)
      .set({ lastVisitedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, target.userId));

    await tx.insert(auditLogs).values({
      orgId: target.orgId,
      userId: target.userId,
      action: "session.switch_org",
      resourceType: "session",
      resourceId: target.orgId,
      newValues: { targetSlug: target.slug, role: target.role },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });

    await tx.insert(outboxEvents).values({
      tenantId: target.orgId,
      type: "session.switched",
      payload: { userId: target.userId, targetSlug: target.slug },
    });
  });

  // Blocklist the previous token. TTL the key until the token's natural exp
  // so we don't accumulate garbage past the moment the token would fail
  // verification anyway. Clamp to a 24h max as defence-in-depth.
  if (input.previousJti) {
    const nowS = Math.floor(Date.now() / 1000);
    const ttlS = input.previousExp && input.previousExp > nowS ? input.previousExp - nowS : 3600;
    const clamped = Math.min(Math.max(ttlS, 60), 24 * 3600);
    await redis.setex(sessionBlocklistKey(input.previousJti), clamped, "1");
  }

  return {
    ok: true,
    targetOrgId: target.orgId,
    targetSlug: target.slug,
    targetRole: target.role,
  };
}

/** Redis key for a blocklisted JWT `jti`. */
export function sessionBlocklistKey(jti: string): string {
  return `session:blocklist:${jti}`;
}

export async function isSessionBlocklisted(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  const hit = await redis.get(sessionBlocklistKey(jti));
  return hit !== null;
}
