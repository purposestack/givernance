/**
 * Provisional-admin dispute service (issue #113 / ADR-016 / doc 22 §3.1, §4.3).
 *
 * Three callers:
 *  - `POST /v1/tenants/:orgId/admin-dispute` — any authenticated tenant
 *    member (not the first_admin) can open a dispute.
 *  - `GET /v1/admin/disputes` + `PATCH /v1/admin/disputes/:id` — super-admin
 *    triage.
 *  - BullMQ expire processor — clears provisional_until flags and closes
 *    non-disputed tenants ("confirmed").
 *
 * Every state transition emits audit + outbox for downstream notifications.
 */

import {
  auditLogs,
  outboxEvents,
  type TenantAdminDisputeResolution,
  tenantAdminDisputes,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, withTenantContext } from "../../lib/db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export type OpenDisputeResult =
  | { ok: true; disputeId: string }
  | {
      ok: false;
      error:
        | "tenant_not_found"
        | "not_a_member"
        | "is_first_admin"
        | "window_closed"
        | "already_disputed";
    };

export interface OpenDisputeInput {
  orgId: string;
  disputerKeycloakSub: string;
  reason?: string;
  audit: {
    ipHash?: string;
    userAgent?: string;
  };
}

export async function openDispute(input: OpenDisputeInput): Promise<OpenDisputeResult> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };

  const [tenant] = await db
    .select({ id: tenants.id, status: tenants.status, createdVia: tenants.createdVia })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant) return { ok: false, error: "tenant_not_found" };

  // Resolve the disputer (must be a tenant member, but NOT first_admin).
  const [disputer] = await db
    .select({
      id: users.id,
      firstAdmin: users.firstAdmin,
    })
    .from(users)
    .where(and(eq(users.keycloakId, input.disputerKeycloakSub), eq(users.orgId, input.orgId)))
    .limit(1);
  if (!disputer) return { ok: false, error: "not_a_member" };
  if (disputer.firstAdmin) return { ok: false, error: "is_first_admin" };

  // Find the current provisional admin of the tenant and their grace window.
  const [provisional] = await db
    .select({ id: users.id, provisionalUntil: users.provisionalUntil })
    .from(users)
    .where(and(eq(users.orgId, input.orgId), eq(users.firstAdmin, true)))
    .limit(1);
  if (!provisional || !provisional.provisionalUntil) {
    // The grace window already closed (expire job cleared the flag) or the
    // tenant never had a provisional admin.
    return { ok: false, error: "window_closed" };
  }
  if (provisional.provisionalUntil <= new Date()) {
    return { ok: false, error: "window_closed" };
  }

  try {
    const disputeId = await withTenantContext(input.orgId, async (tx) => {
      const [row] = await tx
        .insert(tenantAdminDisputes)
        .values({
          orgId: input.orgId,
          disputerId: disputer.id,
          provisionalAdminId: provisional.id,
          reason: input.reason ?? null,
        })
        .returning({ id: tenantAdminDisputes.id });
      // biome-ignore lint/style/noNonNullAssertion: returning() yields one row
      const d = row!;

      await tx.insert(outboxEvents).values({
        tenantId: input.orgId,
        type: "tenant.provisional_admin_disputed",
        payload: {
          tenantId: input.orgId,
          disputeId: d.id,
          disputerId: disputer.id,
          provisionalAdminId: provisional.id,
        },
      });

      await tx.insert(auditLogs).values({
        orgId: input.orgId,
        userId: disputer.id,
        action: "tenant.provisional_admin_disputed",
        resourceType: "tenant_admin_dispute",
        resourceId: d.id,
        newValues: {
          disputerId: disputer.id,
          provisionalAdminId: provisional.id,
        },
        ipHash: input.audit.ipHash,
        userAgent: input.audit.userAgent,
      });

      return d.id;
    });
    return { ok: true, disputeId };
  } catch (err) {
    if (isUniqueViolation(err, /tenant_admin_disputes_one_open_per_tenant/)) {
      return { ok: false, error: "already_disputed" };
    }
    throw err;
  }
}

// ─── Resolution (super-admin) ───────────────────────────────────────────────

export type ResolveDisputeResult =
  | { ok: true; resolution: TenantAdminDisputeResolution }
  | { ok: false; error: "not_found" | "already_resolved" | "target_missing" };

export interface ResolveDisputeInput {
  disputeId: string;
  resolution: TenantAdminDisputeResolution;
  resolverUserKeycloakSub: string;
  audit: {
    ipHash?: string;
    userAgent?: string;
  };
}

/**
 * Close a dispute. On `replaced`: demote old first_admin → `user`, promote
 * the disputer to `org_admin` with `first_admin=true`, both inside a single
 * transaction so the partial unique index can't reject mid-swap. Clears the
 * provisional_until window in all cases — post-resolution, no more dispute.
 */
export async function resolveDispute(input: ResolveDisputeInput): Promise<ResolveDisputeResult> {
  if (!isUuid(input.disputeId)) return { ok: false, error: "not_found" };

  const [dispute] = await db
    .select({
      id: tenantAdminDisputes.id,
      orgId: tenantAdminDisputes.orgId,
      disputerId: tenantAdminDisputes.disputerId,
      provisionalAdminId: tenantAdminDisputes.provisionalAdminId,
      resolution: tenantAdminDisputes.resolution,
    })
    .from(tenantAdminDisputes)
    .where(eq(tenantAdminDisputes.id, input.disputeId))
    .limit(1);

  if (!dispute) return { ok: false, error: "not_found" };
  if (dispute.resolution) return { ok: false, error: "already_resolved" };

  const [resolverUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.keycloakId, input.resolverUserKeycloakSub))
    .limit(1);
  const resolverUserId = resolverUser?.id ?? null;

  if (input.resolution === "replaced") {
    if (!dispute.disputerId || !dispute.provisionalAdminId) {
      return { ok: false, error: "target_missing" };
    }
    await withTenantContext(dispute.orgId, async (tx) => {
      // SWAP: the partial unique index `users_one_first_admin_per_org`
      // requires exactly one first_admin per tenant. Demote first, then
      // promote — inside the same transaction.
      await tx
        .update(users)
        .set({
          role: "user",
          firstAdmin: false,
          provisionalUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, dispute.provisionalAdminId as string));

      await tx
        .update(users)
        .set({
          role: "org_admin",
          firstAdmin: true,
          provisionalUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, dispute.disputerId as string));

      await tx
        .update(tenantAdminDisputes)
        .set({
          resolution: "replaced",
          resolvedAt: new Date(),
          resolvedBy: resolverUserId,
          updatedAt: new Date(),
        })
        .where(eq(tenantAdminDisputes.id, dispute.id));

      await tx.insert(outboxEvents).values({
        tenantId: dispute.orgId,
        type: "tenant.provisional_admin_replaced",
        payload: {
          tenantId: dispute.orgId,
          disputeId: dispute.id,
          newAdminId: dispute.disputerId,
          replacedAdminId: dispute.provisionalAdminId,
        },
      });

      await tx.insert(auditLogs).values({
        orgId: dispute.orgId,
        userId: resolverUserId,
        action: "tenant.provisional_admin_replaced",
        resourceType: "tenant_admin_dispute",
        resourceId: dispute.id,
        newValues: { resolution: "replaced" },
        ipHash: input.audit.ipHash,
        userAgent: input.audit.userAgent,
      });
    });
    return { ok: true, resolution: "replaced" };
  }

  // `kept` / `escalated_to_support`: confirm the provisional admin, clear
  // the grace window (provisional is over), mark the dispute closed.
  await withTenantContext(dispute.orgId, async (tx) => {
    if (input.resolution === "kept" && dispute.provisionalAdminId) {
      await tx
        .update(users)
        .set({ provisionalUntil: null, updatedAt: new Date() })
        .where(eq(users.id, dispute.provisionalAdminId as string));
    }

    await tx
      .update(tenantAdminDisputes)
      .set({
        resolution: input.resolution,
        resolvedAt: new Date(),
        resolvedBy: resolverUserId,
        updatedAt: new Date(),
      })
      .where(eq(tenantAdminDisputes.id, dispute.id));

    await tx.insert(outboxEvents).values({
      tenantId: dispute.orgId,
      type: `tenant.dispute_${input.resolution}`,
      payload: { tenantId: dispute.orgId, disputeId: dispute.id },
    });

    await tx.insert(auditLogs).values({
      orgId: dispute.orgId,
      userId: resolverUserId,
      action: `tenant.dispute_${input.resolution}`,
      resourceType: "tenant_admin_dispute",
      resourceId: dispute.id,
      newValues: { resolution: input.resolution },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });
  });

  return { ok: true, resolution: input.resolution };
}

// ─── Listing for back-office ────────────────────────────────────────────────

export interface DisputeRow {
  id: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  disputerId: string | null;
  provisionalAdminId: string | null;
  reason: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export async function listDisputes(filter: { open?: boolean }): Promise<DisputeRow[]> {
  const where = filter.open ? isNull(tenantAdminDisputes.resolution) : undefined;
  const rows = await db
    .select({
      id: tenantAdminDisputes.id,
      orgId: tenantAdminDisputes.orgId,
      orgSlug: tenants.slug,
      orgName: tenants.name,
      disputerId: tenantAdminDisputes.disputerId,
      provisionalAdminId: tenantAdminDisputes.provisionalAdminId,
      reason: tenantAdminDisputes.reason,
      resolution: tenantAdminDisputes.resolution,
      resolvedAt: tenantAdminDisputes.resolvedAt,
      createdAt: tenantAdminDisputes.createdAt,
    })
    .from(tenantAdminDisputes)
    .innerJoin(tenants, eq(tenantAdminDisputes.orgId, tenants.id))
    .where(where ?? sql`true`)
    .orderBy(sql`${tenantAdminDisputes.createdAt} DESC`)
    .limit(200);

  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    orgSlug: r.orgSlug,
    orgName: r.orgName,
    disputerId: r.disputerId,
    provisionalAdminId: r.provisionalAdminId,
    reason: r.reason,
    resolution: r.resolution,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getDispute(id: string): Promise<DisputeRow | null> {
  if (!isUuid(id)) return null;
  const list = await listDisputes({});
  return list.find((r) => r.id === id) ?? null;
}

// ─── Expire job: clear provisional_until past the grace window ──────────────

export interface ExpireJobResult {
  confirmedOrgIds: string[];
  skippedOrgIds: string[];
}

/**
 * Nightly BullMQ job (`tenant.provisional-admin-expire`):
 *
 *  1. For every user row where `provisional_until <= now()` and `first_admin=true`,
 *     clear `provisional_until`. If no open dispute exists for the tenant,
 *     emit `tenant.provisional_admin_confirmed` — the tenant has "passed"
 *     the grace window.
 *  2. If a dispute is still open, skip clearing — resolution must happen
 *     via super-admin triage first. (The service never clears the flag
 *     while a dispute is pending, otherwise dispute resolution's `replaced`
 *     path would race against the job.)
 */
export async function runExpireJob(now = new Date()): Promise<ExpireJobResult> {
  const candidates = await db
    .select({
      userId: users.id,
      orgId: users.orgId,
    })
    .from(users)
    .where(and(eq(users.firstAdmin, true), sql`${users.provisionalUntil} <= ${now}`));

  const confirmed: string[] = [];
  const skipped: string[] = [];

  for (const row of candidates) {
    // Is there an open dispute on this tenant?
    const [openDispute] = await db
      .select({ id: tenantAdminDisputes.id })
      .from(tenantAdminDisputes)
      .where(and(eq(tenantAdminDisputes.orgId, row.orgId), isNull(tenantAdminDisputes.resolution)))
      .limit(1);

    if (openDispute) {
      skipped.push(row.orgId);
      continue;
    }

    await withTenantContext(row.orgId, async (tx) => {
      await tx
        .update(users)
        .set({ provisionalUntil: null, updatedAt: new Date() })
        .where(eq(users.id, row.userId));

      await tx.insert(outboxEvents).values({
        tenantId: row.orgId,
        type: "tenant.provisional_admin_confirmed",
        payload: { tenantId: row.orgId, userId: row.userId },
      });

      await tx.insert(auditLogs).values({
        orgId: row.orgId,
        userId: null,
        action: "tenant.provisional_admin_confirmed",
        resourceType: "user",
        resourceId: row.userId,
        newValues: { provisionalUntil: null },
      });
    });

    confirmed.push(row.orgId);
  }

  return { confirmedOrgIds: confirmed, skippedOrgIds: skipped };
}

function isUniqueViolation(err: unknown, constraintHint?: RegExp): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== "23505") return false;
  if (!constraintHint) return true;
  return constraintHint.test(e.constraint ?? "") || constraintHint.test(e.message ?? "");
}
