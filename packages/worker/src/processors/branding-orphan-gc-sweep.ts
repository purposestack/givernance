// #291 — branding.orphan_gc_sweep
/**
 * Nightly orphan-GC sweep over the public-read `branding` bucket
 * (ADR-023 § Consequences: "branding bucket lifecycle requires nightly
 * orphan-GC"; ADR-024: replaced logos "drift to nightly orphan-GC").
 *
 * The per-asset `branding.gc_asset` job (enqueued by the explicit
 * DELETE endpoint) is the fast path. This sweep is the safety net for
 * the three orphan sources the fast path structurally misses:
 *
 *   1. Soft-deleted rows past the 7-day grace whose S3 objects are
 *      still around — either the per-asset GC job failed terminally
 *      (S3 outage at delete time, DLQ'd job), or the row was
 *      soft-deleted by logo *replacement* (`branding-activate-logo.ts`
 *      soft-deletes the previous asset when repointing, which is what
 *      starts the 7-day clock at the replacement moment — review H1).
 *      The prefix is swept and the row hard-deleted, per the docs/24
 *      §7 contract.
 *   2. Stale never-activated rows (`pending`/`failed`/`ready` uploads
 *      that never became the active logo), plus legacy replaced rows
 *      from before activation started soft-deleting them. `updated_at`
 *      is a correct grace clock here: these rows' last touch IS the
 *      upload/processing itself.
 *   3. Unowned S3 prefixes: a hard-deleted tenant cascades its
 *      `org_branding_assets` rows away (FK ON DELETE CASCADE), which
 *      can strand the `{org_id}/` prefix in the bucket with no row
 *      left to GC by. Reaped once every object under the prefix is
 *      7+ days old (LastModified — the only clock left).
 *
 * Safety posture (review H2/M1):
 *   - BOTH DB-driven phases exclude anything `tenants.logo_asset_id`
 *     points at — even a soft-deleted row that support manually
 *     re-activated is never reaped.
 *   - The S3 prefix derived from `original_key` must match
 *     `{row.orgId}/logo/…/` exactly, else the row is skipped with a
 *     warning. A malformed key can therefore never widen the delete
 *     to the whole bucket or another tenant's prefix (issue #430:
 *     re-scope even when the column "implies" the tenant).
 *   - Every DB-row reap writes an `audit_logs` entry (GDPR Art. 5(2));
 *     phase-3 reaps cannot (the org's FK target is gone) and rely on
 *     the structured Loki log line instead.
 *
 * NOT done here: Keycloak `logo_url` clearing. The sweep never touches
 * an asset that `tenants.logo_asset_id` still points at, so the KC
 * attribute can never reference a swept prefix; the explicit-delete
 * path already handles its own KC sync via `branding.gc_asset`.
 *
 * Feature-flag gated (`branding.orphan_gc_sweep`, platform scope,
 * default-off) — deletion jobs get a kill-switch, per the
 * feature-flag-first rule for net-new worker jobs.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { auditLogs, orgBrandingAssets, tenants } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";
import {
  deleteBrandingPrefix,
  listBrandingTopLevelPrefixes,
  newestBrandingObjectMtime,
} from "../lib/s3.js";

/** Grace window before an orphan is reaped (docs/24 §7 — audit cover). */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Strict UUID shape — anything else at the bucket root is not ours to touch. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrphanGcSweepResult {
  softDeletedReaped: number;
  replacedReaped: number;
  unownedPrefixesReaped: number;
  objectsDeleted: number;
  skipped: boolean;
}

interface OrphanRow {
  id: string;
  orgId: string;
  originalKey: string;
}

/**
 * Derive the `{org}/logo/{asset}/` S3 prefix from a stored original
 * key — same derivation the explicit-delete path uses (branding
 * service, PR #287) — and REFUSE anything that doesn't sit strictly
 * under this row's own `{orgId}/logo/` namespace (review H2). Returns
 * null on refusal: a malformed/empty/cross-tenant `original_key` must
 * never widen a destructive prefix-delete beyond the row's own asset
 * directory.
 */
function safePrefixFromOriginalKey(row: OrphanRow): string | null {
  const lastSlash = row.originalKey.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const prefix = `${row.originalKey.substring(0, lastSlash)}/`;
  const namespace = `${row.orgId}/logo/`;
  // Must be `{orgId}/logo/<something>/` — deeper than the namespace
  // itself, so we can never delete the whole `{orgId}/logo/` tree.
  if (!prefix.startsWith(namespace) || prefix.length <= namespace.length) return null;
  return prefix;
}

/**
 * Sweep one orphan row: delete its S3 prefix, hard-delete the row,
 * write the audit trail. Returns the number of S3 objects deleted, or
 * null when the row was skipped (unsafe prefix) or failed (logged;
 * retried on the next nightly run).
 */
async function reapRow(
  row: OrphanRow,
  phase: "soft_deleted" | "stale_unactivated",
  log: ReturnType<typeof jobLogger>,
): Promise<number | null> {
  const prefix = safePrefixFromOriginalKey(row);
  if (!prefix) {
    // Never delete on a malformed key — a human looks at this row.
    log.warn(
      { assetId: row.id, orgId: row.orgId, originalKey: row.originalKey, phase },
      "orphan row has an out-of-namespace original_key — skipping (manual review needed)",
    );
    return null;
  }
  try {
    const deleted = await deleteBrandingPrefix(prefix);
    await db
      .delete(orgBrandingAssets)
      // Issue #430 — explicit org filter even on a PK delete.
      .where(and(eq(orgBrandingAssets.id, row.id), eq(orgBrandingAssets.orgId, row.orgId)));
    // GDPR Art. 5(2) accountability for a permanent deletion (review
    // B1) — same posture as the cache-flush rule (issue #449). The org
    // still exists in phases 1–2, so the FK holds.
    await db.insert(auditLogs).values({
      orgId: row.orgId,
      userId: null,
      action: "branding.orphan_gc_reaped",
      resourceType: "org_branding_asset",
      resourceId: row.id,
      newValues: { phase, prefix, objectsDeleted: deleted },
    });
    return deleted;
  } catch (err) {
    // Per-row failures don't abort the sweep — the row stays and the
    // next nightly run retries it.
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn({ assetId: row.id, orgId: row.orgId, phase, err: message }, "orphan reap failed");
    return null;
  }
}

export async function processBrandingOrphanGcSweep(job: Job): Promise<OrphanGcSweepResult> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });

  // Defence-in-depth kill-switch: this job deletes objects and rows, so
  // the flag gate sits at pickup, before any listing happens.
  if (!(await isFlagEnabled(FEATURE_FLAG_KEYS.BRANDING_ORPHAN_GC_SWEEP))) {
    log.info("branding.orphan_gc_sweep flag is off — skipping sweep");
    return {
      softDeletedReaped: 0,
      replacedReaped: 0,
      unownedPrefixesReaped: 0,
      objectsDeleted: 0,
      skipped: true,
    };
  }

  const grace = new Date(Date.now() - GRACE_MS);
  let objectsDeleted = 0;

  // Shared guard for both DB-driven phases (review M1): never reap a
  // row the tenant's active pointer references — covers the support
  // scenario where a soft-deleted logo is manually re-activated via
  // `UPDATE tenants SET logo_asset_id = …` without clearing
  // `deleted_at`. `IS DISTINCT FROM` treats a NULL pointer (logo
  // removed, or tenant row gone) as "not pointing at this row".
  const notActivePointer = sql`${tenants.logoAssetId} IS DISTINCT FROM ${orgBrandingAssets.id}`;

  // ── Phase 1 — soft-deleted rows past grace ─────────────────────────
  // CROSS-TENANT INTENTIONAL: platform-wide cron sweep — orphaned rows
  // are collected across every tenant in one job tick. Owner-pool
  // (`db`) is used because every per-row mutation re-scopes by BOTH
  // `id` AND `org_id`; we never touch a row without its own org_id in
  // the predicate (issue #430 posture).
  const softDeleted = await db
    .select({
      id: orgBrandingAssets.id,
      orgId: orgBrandingAssets.orgId,
      originalKey: orgBrandingAssets.originalKey,
    })
    .from(orgBrandingAssets)
    .leftJoin(tenants, eq(tenants.id, orgBrandingAssets.orgId))
    .where(
      and(
        isNotNull(orgBrandingAssets.deletedAt),
        lt(orgBrandingAssets.deletedAt, grace),
        notActivePointer,
      ),
    );

  let softDeletedReaped = 0;
  for (const row of softDeleted) {
    const deleted = await reapRow(row, "soft_deleted", log);
    if (deleted !== null) {
      objectsDeleted += deleted;
      softDeletedReaped += 1;
    }
  }

  // ── Phase 2 — stale never-activated rows past grace ────────────────
  // Replaced logos are soft-deleted at activation time (see
  // `branding-activate-logo.ts`) and handled by Phase 1 with an exact
  // replacement-time clock. This phase catches what never activated
  // (`pending`/`failed`/never-pointed `ready` rows) plus legacy
  // replaced rows from before activation soft-deleted them —
  // `updated_at` is a correct clock for those: their last touch is the
  // upload/processing itself.
  // CROSS-TENANT INTENTIONAL: same posture as Phase 1.
  const stale = await db
    .select({
      id: orgBrandingAssets.id,
      orgId: orgBrandingAssets.orgId,
      originalKey: orgBrandingAssets.originalKey,
    })
    .from(orgBrandingAssets)
    .leftJoin(tenants, eq(tenants.id, orgBrandingAssets.orgId))
    .where(
      and(
        isNull(orgBrandingAssets.deletedAt),
        lt(orgBrandingAssets.updatedAt, grace),
        notActivePointer,
      ),
    );

  let replacedReaped = 0;
  for (const row of stale) {
    const deleted = await reapRow(row, "stale_unactivated", log);
    if (deleted !== null) {
      objectsDeleted += deleted;
      replacedReaped += 1;
    }
  }

  // ── Phase 3 — unowned `{org_id}/` prefixes ─────────────────────────
  // Reconcile the bucket's top-level prefixes against live tenants.
  // Only strict-UUID prefixes are candidates — anything else at the
  // root is unexpected layout and gets a warning, never a delete.
  let unownedPrefixesReaped = 0;
  try {
    const prefixes = await listBrandingTopLevelPrefixes();
    if (prefixes.length > 0) {
      // CROSS-TENANT INTENTIONAL: the live-tenant id set is the
      // reconciliation target for the whole bucket.
      const liveTenants = await db.select({ id: tenants.id }).from(tenants);
      const liveIds = new Set(liveTenants.map((t) => t.id.toLowerCase()));

      for (const prefix of prefixes) {
        const orgId = prefix.replace(/\/$/, "");
        if (!UUID_RE.test(orgId)) {
          log.warn({ prefix }, "non-UUID top-level prefix in branding bucket — skipping");
          continue;
        }
        if (liveIds.has(orgId.toLowerCase())) continue;

        try {
          // No DB row left to date the orphan by — use the newest
          // object's LastModified as the grace clock. No audit_logs
          // row either: `audit_logs.org_id` FK-references the tenant
          // that no longer exists, so the structured log line below is
          // the accountability trail for this phase.
          const newest = await newestBrandingObjectMtime(prefix);
          if (!newest || newest >= grace) continue;
          const deleted = await deleteBrandingPrefix(prefix);
          objectsDeleted += deleted;
          unownedPrefixesReaped += 1;
          log.info({ prefix, objectsDeleted: deleted }, "unowned branding prefix reaped");
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          log.warn({ prefix, err: message }, "unowned prefix reap failed");
        }
      }
    }
  } catch (err) {
    // A LIST failure only skips Phase 3 — the DB-driven phases already
    // completed and their work is committed.
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn({ err: message }, "top-level prefix listing failed — phase 3 skipped");
  }

  const result: OrphanGcSweepResult = {
    softDeletedReaped,
    replacedReaped,
    unownedPrefixesReaped,
    objectsDeleted,
    skipped: false,
  };
  log.info(result, "branding orphan-GC sweep complete");
  return result;
}
