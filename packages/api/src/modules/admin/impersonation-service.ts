/**
 * Service layer for the support-session API (issue #24).
 *
 * Responsibilities:
 *   - Resolve the target user (Keycloak `sub` + role + email) and tenant.
 *   - Mint the impersonation token (app-layer or Keycloak Token Exchange).
 *   - Persist the session row + Redis state + audit event.
 *   - Atomically end / revoke a session.
 *
 * Two coexisting modes — see docs/19-impersonation.md. The mode-specific
 * differences land in `buildSessionPlan()` (TTL + roles array) so the
 * happy path stays linear.
 */

import { createHash } from "node:crypto";
import { PLATFORM_TENANT_ID } from "@givernance/shared/constants";
import { auditLogs, impersonationSessions, tenants, users } from "@givernance/shared/schema";
import type { ImpersonationModeName } from "@givernance/shared/types";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { env } from "../../env.js";
import { systemDb, withTenantContext } from "../../lib/db.js";
import { signImpersonationToken } from "../../lib/impersonation/jwt.js";
import { exchangeTokenViaKeycloak } from "../../lib/impersonation/keycloak-exchange.js";
import {
  recordActiveSession,
  endSession as redisEndSession,
} from "../../lib/impersonation/redis-store.js";

const DELEGATION_TTL_CAP_SECONDS = 4 * 60 * 60;
const IMPERSONATION_TTL_CAP_SECONDS = 60 * 60;

export interface StartSessionInput {
  impersonatorKeycloakId: string;
  operatorAccessToken: string;
  targetUserId: string; // app-side users.id (uuid)
  mode: ImpersonationModeName;
  reason: string;
  ipHash: string | null;
  userAgent: string | null;
}

export interface StartSessionResult {
  sessionId: string;
  token: string;
  expiresAt: Date;
  targetOrgId: string;
  targetKeycloakId: string;
  jti: string;
}

export class ImpersonationServiceError extends Error {
  readonly status: number;
  readonly code:
    | "TARGET_NOT_FOUND"
    | "TARGET_SOFT_DELETED"
    | "TARGET_NESTED_SUPER_ADMIN"
    | "BAD_REQUEST";
  constructor(status: number, code: ImpersonationServiceError["code"], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const target = await resolveTarget(input.targetUserId);

  // Reject impersonating any user who belongs to the platform tenant
  // (super-admins live there). The `users.role` enum has no `super_admin`
  // value — that role is realm-level only — so the structural signal is
  // the target's `org_id`. Nested operator-on-operator impersonation
  // breaks the audit chain and has no legitimate support use case.
  if (target.orgId === PLATFORM_TENANT_ID) {
    throw new ImpersonationServiceError(
      400,
      "TARGET_NESTED_SUPER_ADMIN",
      "Cannot impersonate a platform user; nested impersonation is forbidden.",
    );
  }

  const plan = buildSessionPlan(input.mode, target.role);
  const ttlSeconds = plan.ttlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Insert the session row + the matching `impersonation.started` audit
  // entry in a single transaction so we never end up with an active
  // session that has no audit trail (review H1). The Redis record + token
  // mint stay outside the transaction because (a) they don't share the
  // Postgres connection, and (b) a later failure there leaves a session
  // row that the auth plugin will reject (no Redis record → 401), which is
  // the safer fail-mode.
  const sessionRow = await systemDb.transaction(async (tx) => {
    const [row] = await tx
      .insert(impersonationSessions)
      .values({
        impersonatorKeycloakId: input.impersonatorKeycloakId,
        targetKeycloakId: target.keycloakId,
        targetOrgId: target.orgId,
        targetRole: target.role,
        mode: input.mode,
        reason: input.reason,
        expiresAt,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      })
      .returning();
    if (!row) throw new Error("startSession: insert returned no row");

    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${target.orgId}, true)`);
    await tx.insert(auditLogs).values({
      orgId: target.orgId,
      userId: target.keycloakId,
      actorId: input.impersonatorKeycloakId,
      impersonationSessionId: row.id,
      impersonationMode: input.mode,
      action: "impersonation.started",
      resourceType: "impersonation_session",
      resourceId: row.id,
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });

    return row;
  });

  const token = await mintToken({
    sessionId: sessionRow.id,
    mode: input.mode,
    reason: input.reason,
    targetKeycloakId: target.keycloakId,
    targetOrgId: target.orgId,
    targetRole: target.role,
    targetEmail: target.email,
    roles: plan.roles,
    impersonatorKeycloakId: input.impersonatorKeycloakId,
    operatorAccessToken: input.operatorAccessToken,
    ttlSeconds,
  });

  await recordActiveSession({
    sessionId: sessionRow.id,
    mode: input.mode,
    impersonatorKeycloakId: input.impersonatorKeycloakId,
    targetKeycloakId: target.keycloakId,
    targetOrgId: target.orgId,
    targetRole: target.role,
    reason: input.reason,
    expiresAt: token.exp,
    jti: token.jti,
  });

  // (Lifecycle `impersonation.started` was already audited inside the
  // session-insert transaction above — review H1.)

  return {
    sessionId: sessionRow.id,
    token: token.token,
    expiresAt,
    targetOrgId: target.orgId,
    targetKeycloakId: target.keycloakId,
    jti: token.jti,
  };
}

interface MintTokenInput extends Omit<StartSessionInput, "targetUserId" | "ipHash" | "userAgent"> {
  sessionId: string;
  targetKeycloakId: string;
  targetOrgId: string;
  targetRole: string;
  targetEmail: string;
  roles: string[];
  ttlSeconds: number;
}

async function mintToken(
  input: MintTokenInput,
): Promise<{ token: string; jti: string; exp: number }> {
  if (env.IMPERSONATION_USE_KEYCLOAK_EXCHANGE) {
    return exchangeTokenViaKeycloak({
      operatorAccessToken: input.operatorAccessToken,
      operatorKeycloakId: input.impersonatorKeycloakId,
      targetKeycloakId: input.targetKeycloakId,
      sessionId: input.sessionId,
      mode: input.mode,
      reason: input.reason,
      ttlSeconds: input.ttlSeconds,
    });
  }
  return signImpersonationToken({
    sessionId: input.sessionId,
    mode: input.mode,
    reason: input.reason,
    targetKeycloakId: input.targetKeycloakId,
    targetOrgId: input.targetOrgId,
    targetRole: input.targetRole,
    targetEmail: input.targetEmail,
    roles: input.roles,
    impersonatorKeycloakId: input.impersonatorKeycloakId,
    ttlSeconds: input.ttlSeconds,
  });
}

interface ResolvedTarget {
  keycloakId: string;
  orgId: string;
  role: string;
  email: string;
}

async function resolveTarget(targetUserId: string): Promise<ResolvedTarget> {
  // Cross-tenant lookup — the operator is super_admin so RLS is bypassed
  // here on purpose. systemDb runs as the BYPASSRLS owner role.
  const [row] = await systemDb
    .select({
      keycloakId: users.keycloakId,
      orgId: users.orgId,
      role: users.role,
      email: users.email,
      deletedAt: users.deletedAt,
      tenantStatus: tenants.status,
    })
    .from(users)
    .leftJoin(tenants, eq(tenants.id, users.orgId))
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!row) {
    throw new ImpersonationServiceError(404, "TARGET_NOT_FOUND", "Target user not found");
  }
  if (row.deletedAt) {
    throw new ImpersonationServiceError(
      404,
      "TARGET_SOFT_DELETED",
      "Target user has been removed (ADR-021 soft-delete)",
    );
  }
  if (!row.keycloakId) {
    throw new ImpersonationServiceError(
      400,
      "BAD_REQUEST",
      "Target user has no Keycloak identity — cannot mint impersonation token",
    );
  }
  if (row.tenantStatus === "archived" || row.tenantStatus === "suspended") {
    throw new ImpersonationServiceError(
      400,
      "BAD_REQUEST",
      `Target tenant is ${row.tenantStatus} — refusing to start an impersonation session`,
    );
  }
  return {
    keycloakId: row.keycloakId,
    orgId: row.orgId,
    role: row.role,
    email: row.email,
  };
}

interface SessionPlan {
  ttlSeconds: number;
  roles: string[];
}

function buildSessionPlan(mode: ImpersonationModeName, targetRole: string): SessionPlan {
  if (mode === "delegation") {
    return {
      ttlSeconds: Math.min(env.IMPERSONATION_DELEGATION_TTL_SECONDS, DELEGATION_TTL_CAP_SECONDS),
      // Operator's super_admin powers retained — that's the whole point of
      // delegation ("droits étendus si nécessaire" per issue #24). The
      // sub/org_id still pin the operator into the target tenant for RLS.
      roles: ["super_admin"],
    };
  }
  // Pure impersonation — operator becomes the user. No super_admin in the
  // roles array means the impersonation plugin's RBAC checks pass through
  // the target user's own role and the write-block engages.
  return {
    ttlSeconds: Math.min(
      env.IMPERSONATION_IMPERSONATION_TTL_SECONDS,
      IMPERSONATION_TTL_CAP_SECONDS,
    ),
    roles: [targetRole],
  };
}

export interface ListSessionsOptions {
  activeOnly?: boolean;
  limit?: number;
}

export async function listSessions(opts: ListSessionsOptions = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.activeOnly
    ? and(isNull(impersonationSessions.endedAt), gt(impersonationSessions.expiresAt, new Date()))
    : undefined;
  return systemDb
    .select()
    .from(impersonationSessions)
    .where(where)
    .orderBy(desc(impersonationSessions.createdAt))
    .limit(limit);
}

/**
 * Picker-scoped user search for the start-impersonation form (super-admin
 * only). Cross-tenant by definition; runs through `systemDb` (BYPASSRLS)
 * since super-admin operates outside any tenant context. Excludes
 * platform-tenant users (they can't be impersonated — see startSession).
 */
export interface ImpersonationTargetCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  keycloakId: string | null;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
}

export async function searchTargets(filters: {
  q?: string;
  tenantId?: string;
  limit?: number;
}): Promise<ImpersonationTargetCandidate[]> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  const conditions = [isNull(users.deletedAt), sql`${users.orgId} != ${PLATFORM_TENANT_ID}::uuid`];

  if (filters.tenantId) {
    conditions.push(eq(users.orgId, filters.tenantId));
  }

  if (filters.q) {
    const raw = filters.q.trim();
    if (raw.length > 0) {
      const like = `%${raw.toLowerCase()}%`;
      // Exact UUID match short-circuits via OR — paste-the-UUID flow still
      // works for operators who already have one. Otherwise ILIKE on the
      // first/last/email substring; case folded in SQL so it works
      // regardless of the value's stored casing.
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(raw)) {
        conditions.push(
          sql`(${users.id} = ${raw}::uuid OR ${users.keycloakId} = ${raw} OR lower(${users.email}) LIKE ${like})`,
        );
      } else {
        conditions.push(
          sql`(lower(${users.firstName}) LIKE ${like} OR lower(${users.lastName}) LIKE ${like} OR lower(${users.email}) LIKE ${like})`,
        );
      }
    }
  }

  const rows = await systemDb
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      role: users.role,
      keycloakId: users.keycloakId,
      tenantId: tenants.id,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.orgId))
    .where(and(...conditions))
    .orderBy(users.lastName, users.firstName)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    role: r.role,
    keycloakId: r.keycloakId ?? null,
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    tenantSlug: r.tenantSlug,
  }));
}

/** Lightweight tenant list for the picker — non-platform, non-archived. */
export async function listTenantsForPicker(
  q?: string,
): Promise<Array<{ id: string; name: string; slug: string; status: string }>> {
  const conditions = [
    sql`${tenants.id} != ${PLATFORM_TENANT_ID}::uuid`,
    sql`${tenants.status} != 'archived'`,
  ];
  if (q) {
    const raw = q.trim();
    if (raw.length > 0) {
      const like = `%${raw.toLowerCase()}%`;
      conditions.push(
        sql`(lower(${tenants.name}) LIKE ${like} OR lower(${tenants.slug}) LIKE ${like})`,
      );
    }
  }
  return systemDb
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
    })
    .from(tenants)
    .where(and(...conditions))
    .orderBy(tenants.name)
    .limit(50);
}

export async function getSession(sessionId: string) {
  const [row] = await systemDb
    .select()
    .from(impersonationSessions)
    .where(eq(impersonationSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

export async function endSession(args: {
  sessionId: string;
  reason: "manual" | "revoked";
  byImpersonatorKeycloakId: string;
  ipHash: string | null;
  userAgent: string | null;
}): Promise<{ ended: boolean; targetOrgId: string | null }> {
  const session = await getSession(args.sessionId);
  if (!session) return { ended: false, targetOrgId: null };
  if (session.endedAt) return { ended: false, targetOrgId: session.targetOrgId };

  await systemDb
    .update(impersonationSessions)
    .set({ endedAt: new Date(), endReason: args.reason })
    .where(
      and(eq(impersonationSessions.id, args.sessionId), isNull(impersonationSessions.endedAt)),
    );

  await redisEndSession(args.sessionId);

  await emitLifecycleAudit({
    orgId: session.targetOrgId,
    userId: session.targetKeycloakId,
    actorId: args.byImpersonatorKeycloakId,
    sessionId: session.id,
    mode: session.mode,
    action: args.reason === "revoked" ? "impersonation.revoked" : "impersonation.ended_by_admin",
    ipHash: args.ipHash,
    userAgent: args.userAgent,
  });

  return { ended: true, targetOrgId: session.targetOrgId };
}

/**
 * Bulk revoke — used by the emergency endpoint for a target user. Returns
 * the list of revoked session ids so the route can audit per-session.
 */
export async function revokeSessionsForTarget(args: {
  targetKeycloakId: string;
  byImpersonatorKeycloakId: string;
  ipHash: string | null;
  userAgent: string | null;
}): Promise<string[]> {
  const open = await systemDb
    .select({ id: impersonationSessions.id })
    .from(impersonationSessions)
    .where(
      and(
        eq(impersonationSessions.targetKeycloakId, args.targetKeycloakId),
        isNull(impersonationSessions.endedAt),
      ),
    );

  for (const { id } of open) {
    await endSession({
      sessionId: id,
      reason: "revoked",
      byImpersonatorKeycloakId: args.byImpersonatorKeycloakId,
      ipHash: args.ipHash,
      userAgent: args.userAgent,
    });
  }
  return open.map((s) => s.id);
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

interface LifecycleAuditInput {
  orgId: string;
  userId: string;
  actorId: string;
  sessionId: string;
  mode: ImpersonationModeName;
  action: string;
  ipHash: string | null;
  userAgent: string | null;
}

async function emitLifecycleAudit(input: LifecycleAuditInput): Promise<void> {
  // Lifecycle events are audited under the target tenant — the same place
  // the actions performed inside the session land — so an SOC reviewer
  // grep'ing for a tenant's audit trail sees the full session lifecycle.
  await withTenantContext(input.orgId, async (tx) => {
    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.userId,
      actorId: input.actorId,
      impersonationSessionId: input.sessionId,
      impersonationMode: input.mode,
      action: input.action,
      resourceType: "impersonation_session",
      resourceId: input.sessionId,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });
  });
}

/** Forced-exit util used by tests to scrub sessions between cases. */
export async function _testOnly_purgeSessionsForOperator(
  operatorKeycloakId: string,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("_testOnly_purgeSessionsForOperator is forbidden in production");
  }
  await systemDb.execute(
    sql`UPDATE impersonation_sessions SET ended_at = NOW(), end_reason = 'manual' WHERE impersonator_keycloak_id = ${operatorKeycloakId} AND ended_at IS NULL`,
  );
}
