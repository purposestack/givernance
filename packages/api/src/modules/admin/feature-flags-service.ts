/**
 * Admin-side feature-flag write service (issue #326 / PR #352 +
 * Epic #365 Phase 2 expansion).
 *
 * Two responsibility areas:
 *
 *   1. **Platform default toggles** — `setFeatureFlag(...)` flips
 *      `feature_flags.enabled` and returns the row + previous value
 *      so the route's structured log line can record a BEFORE/AFTER
 *      discriminator without an extra round-trip. (Unchanged from
 *      Phase 1.)
 *
 *   2. **Per-tenant overrides** (Epic #365 / doc 18 § 4.2):
 *      `upsertTenantOverride(...)` and `removeTenantOverride(...)`
 *      maintain rows in `tenant_flag_overrides`. The natural upsert
 *      key is `(tenant_id, flag_key)` so a re-PUT with the same
 *      payload is an UPDATE, not a duplicate INSERT.
 *
 * Reads live in `lib/flags/flag-service.ts`. The split matches the
 * rest of the admin module shape: read-cache concerns ≠ write/audit
 * concerns.
 */

import { featureFlags, tenantFlagOverrides } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { db, systemDb, withTenantContext } from "../../lib/db.js";

export interface FlagToggleResult {
  row: {
    key: string;
    enabled: boolean;
    label: string;
    description: string;
    scope: "platform" | "tenant";
    tenantOverrideAllowed: boolean;
    public: boolean;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  /** Value before this PATCH. Useful for BEFORE/AFTER audit log lines. */
  previousEnabled: boolean;
}

/**
 * Flip a flag's `enabled` to the supplied value. Returns `null` when
 * the key isn't in the registry — the route renders that as a 404
 * (anti-disclosure: same response shape as a typo'd URL).
 *
 * `updatedBy` is the internal users.id when available (always null for
 * platform-admin super-admins; tenant-admin flags would carry their
 * users.id if the flag-edit surface ever opens up tenant-side).
 *
 * No-ops (current value already matches the requested value) still
 * bump `updated_at` so the audit_logs row is queryable as "the
 * admin clicked Save at 14:32" even when nothing changed.
 */
export async function setFeatureFlag(
  key: string,
  enabled: boolean,
  updatedBy: string | null,
): Promise<FlagToggleResult | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);

    if (!current) return null;

    const [updated] = await tx
      .update(featureFlags)
      .set({ enabled, updatedBy, updatedAt: new Date() })
      .where(eq(featureFlags.key, key))
      .returning({
        key: featureFlags.key,
        enabled: featureFlags.enabled,
        label: featureFlags.label,
        description: featureFlags.description,
        scope: featureFlags.scope,
        tenantOverrideAllowed: featureFlags.tenantOverrideAllowed,
        public: featureFlags.public,
        updatedBy: featureFlags.updatedBy,
        createdAt: featureFlags.createdAt,
        updatedAt: featureFlags.updatedAt,
      });

    if (!updated) return null;

    return {
      row: {
        key: updated.key,
        enabled: updated.enabled,
        label: updated.label,
        description: updated.description,
        scope: updated.scope,
        tenantOverrideAllowed: updated.tenantOverrideAllowed,
        public: updated.public,
        updatedBy: updated.updatedBy,
        createdAt:
          updated.createdAt instanceof Date
            ? updated.createdAt.toISOString()
            : String(updated.createdAt),
        updatedAt:
          updated.updatedAt instanceof Date
            ? updated.updatedAt.toISOString()
            : String(updated.updatedAt),
      },
      previousEnabled: current.enabled,
    };
  });
}

/** Why a given override write was rejected. Drives the route's HTTP status. */
export type OverrideRejection =
  | "flag_not_found"
  | "platform_scoped"
  | "tenant_override_not_allowed";

export interface OverrideUpsertResult {
  row: {
    tenantId: string;
    flagKey: string;
    value: boolean;
    reason: string | null;
    setBy: string | null;
    setAt: string;
  };
  /** Previous override value if one existed. Useful for audit BEFORE/AFTER. */
  previousValue: boolean | null;
}

/**
 * Resolve a flag for write access. Returns the row when writable +
 * the gate that's blocking the write otherwise. Centralises the
 * "is this flag actually writable from a given caller's
 * perspective" check so the route handlers stay focused on HTTP.
 *
 * `actor` decides which gates apply:
 *   - `super_admin` can write any `scope='tenant'` flag, ignoring
 *     `tenant_override_allowed` (the column is for org-admin self-
 *     service; super-admin holds the master key).
 *   - `org_admin` can write only `scope='tenant' AND
 *     tenant_override_allowed=true`.
 *
 * Returns `rejection` (never throws) so the route layer can map to
 * the appropriate HTTP status without an exception round-trip.
 */
export async function resolveOverrideTarget(
  flagKey: string,
  actor: "super_admin" | "org_admin",
): Promise<{ writable: true } | { writable: false; rejection: OverrideRejection }> {
  const [row] = await db
    .select({
      scope: featureFlags.scope,
      tenantOverrideAllowed: featureFlags.tenantOverrideAllowed,
    })
    .from(featureFlags)
    .where(eq(featureFlags.key, flagKey))
    .limit(1);

  if (!row) return { writable: false, rejection: "flag_not_found" };
  if (row.scope === "platform") return { writable: false, rejection: "platform_scoped" };
  if (actor === "org_admin" && !row.tenantOverrideAllowed) {
    return { writable: false, rejection: "tenant_override_not_allowed" };
  }
  return { writable: true };
}

/**
 * Two service paths: super-admin acts cross-tenant on an arbitrary
 * tenantId; org-admin acts on their own org. The security model
 * differs (super-admin is auth-gated at the route; org-admin layers
 * RLS as defence-in-depth), so the underlying DB connection differs
 * — super-admin uses `systemDb` (BYPASSRLS owner pool, matches the
 * `platform-admins-service.ts` pattern), org-admin uses
 * `withTenantContext(orgId)` so the FORCE-RLS policy on
 * `tenant_flag_overrides` still enforces target=caller-org. Two
 * separate functions surface this distinction at the type level.
 *
 * Returns `null` ONLY when the flag doesn't exist in the registry.
 * Scope / override-allowed gating happens upstream in
 * `resolveOverrideTarget` so the route picks the right HTTP status.
 */

/**
 * Drizzle transaction type extracted from the configured `db`
 * instance — same pattern as `withTenantContext` uses internally.
 * Lets the per-path super-admin / org-admin functions share the
 * core upsert logic without coupling to the concrete pool.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function performUpsert(
  tx: Tx,
  args: {
    tenantId: string;
    flagKey: string;
    value: boolean;
    reason: string | null;
    setBy: string | null;
  },
): Promise<OverrideUpsertResult | null> {
  // Ensure the flag exists — without this guard the FK would 23503
  // and the caller can't distinguish the failure modes cleanly.
  const [flagRow] = await tx
    .select({ key: featureFlags.key })
    .from(featureFlags)
    .where(eq(featureFlags.key, args.flagKey))
    .limit(1);
  if (!flagRow) return null;

  const [existing] = await tx
    .select({ value: tenantFlagOverrides.value })
    .from(tenantFlagOverrides)
    .where(
      and(
        eq(tenantFlagOverrides.tenantId, args.tenantId),
        eq(tenantFlagOverrides.flagKey, args.flagKey),
      ),
    )
    .limit(1);

  const now = new Date();
  const [upserted] = await tx
    .insert(tenantFlagOverrides)
    .values({
      tenantId: args.tenantId,
      flagKey: args.flagKey,
      value: args.value,
      reason: args.reason,
      setBy: args.setBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [tenantFlagOverrides.tenantId, tenantFlagOverrides.flagKey],
      set: {
        value: args.value,
        reason: args.reason,
        setBy: args.setBy,
        updatedAt: now,
      },
    })
    .returning({
      tenantId: tenantFlagOverrides.tenantId,
      flagKey: tenantFlagOverrides.flagKey,
      value: tenantFlagOverrides.value,
      reason: tenantFlagOverrides.reason,
      setBy: tenantFlagOverrides.setBy,
      updatedAt: tenantFlagOverrides.updatedAt,
    });

  if (!upserted) return null;

  return {
    row: {
      tenantId: upserted.tenantId,
      flagKey: upserted.flagKey,
      value: upserted.value,
      reason: upserted.reason,
      setBy: upserted.setBy,
      setAt:
        upserted.updatedAt instanceof Date
          ? upserted.updatedAt.toISOString()
          : String(upserted.updatedAt),
    },
    previousValue: existing?.value ?? null,
  };
}

/**
 * Super-admin upsert — runs on `systemDb` (BYPASSRLS). Auth was
 * already gated by `requireSuperAdmin`; RLS is irrelevant because
 * the route is the security boundary, not the row policy.
 */
export async function upsertOverrideAsSuperAdmin(args: {
  tenantId: string;
  flagKey: string;
  value: boolean;
  reason: string | null;
  setBy: string | null;
}): Promise<OverrideUpsertResult | null> {
  return systemDb.transaction(async (tx) => performUpsert(tx, args));
}

/**
 * Org-admin upsert — runs inside `withTenantContext(orgId)` so the
 * FORCE-RLS policy on `tenant_flag_overrides` matches target
 * tenant_id against the GUC. This is defence-in-depth: even if a
 * future bug let an org-admin pass a mismatched tenantId, the RLS
 * check would still reject the write.
 *
 * `orgId` is the caller's own org from the JWT — the route must
 * never accept it as a request parameter.
 */
export async function upsertOwnOrgOverride(args: {
  orgId: string;
  flagKey: string;
  value: boolean;
  reason: string | null;
  setBy: string | null;
}): Promise<OverrideUpsertResult | null> {
  return withTenantContext(args.orgId, async (tx) =>
    performUpsert(tx, {
      tenantId: args.orgId,
      flagKey: args.flagKey,
      value: args.value,
      reason: args.reason,
      setBy: args.setBy,
    }),
  );
}

async function performDelete(
  tx: Tx,
  tenantId: string,
  flagKey: string,
): Promise<{ previousValue: boolean } | null> {
  const [deleted] = await tx
    .delete(tenantFlagOverrides)
    .where(
      and(eq(tenantFlagOverrides.tenantId, tenantId), eq(tenantFlagOverrides.flagKey, flagKey)),
    )
    .returning({ value: tenantFlagOverrides.value });
  return deleted ? { previousValue: deleted.value } : null;
}

/**
 * Super-admin delete — `systemDb` (BYPASSRLS). Returns `previousValue`
 * when a row was deleted; `null` when no row existed (route renders
 * 204 either way per anti-disclosure intent).
 */
export async function removeOverrideAsSuperAdmin(
  tenantId: string,
  flagKey: string,
): Promise<{ previousValue: boolean } | null> {
  return systemDb.transaction(async (tx) => performDelete(tx, tenantId, flagKey));
}

/**
 * Org-admin delete — `withTenantContext(orgId)` enforces the RLS
 * policy. `orgId` is from the JWT, never a request parameter.
 */
export async function removeOwnOrgOverride(
  orgId: string,
  flagKey: string,
): Promise<{ previousValue: boolean } | null> {
  return withTenantContext(orgId, async (tx) => performDelete(tx, orgId, flagKey));
}
