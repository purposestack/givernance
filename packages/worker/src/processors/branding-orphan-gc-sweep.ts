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
 *   1. Soft-deleted rows past the 7-day grace whose per-asset GC job
 *      failed terminally (S3 outage at delete time, DLQ'd job) — the
 *      S3 prefix is re-swept and the row is hard-deleted, per the
 *      docs/24 §7 contract ("removes their S3 keys … before
 *      hard-deleting the row. The 7-day window covers the audit case").
 *   2. Replaced / stale rows: uploading a new logo mints a NEW
 *      `{logo_id}` and repoints `tenants.logo_asset_id` — the previous
 *      row is never soft-deleted (ADR-024, content-addressed keys).
 *      Also covers uploads stuck in `pending`/`failed` that never
 *      activated. Reaped once `updated_at` is 7+ days old.
 *   3. Unowned S3 prefixes: a hard-deleted tenant cascades its
 *      `org_branding_assets` rows away (FK ON DELETE CASCADE), which
 *      can strand the `{org_id}/` prefix in the bucket with no row
 *      left to GC by. Reaped once every object under the prefix is
 *      7+ days old (LastModified — the only clock left).
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
import { orgBrandingAssets, tenants } from "@givernance/shared/schema";
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

/**
 * Derive the `{org}/logo/{asset}/` S3 prefix from a stored original
 * key — same derivation the explicit-delete path uses (branding
 * service, PR #287).
 */
function prefixFromOriginalKey(originalKey: string): string {
  const lastSlash = originalKey.lastIndexOf("/");
  return lastSlash > 0 ? `${originalKey.substring(0, lastSlash)}/` : originalKey;
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

  // ── Phase 1 — soft-deleted rows past grace ─────────────────────────
  // CROSS-TENANT INTENTIONAL: platform-wide cron sweep — orphaned rows
  // are collected across every tenant in one job tick. Owner-pool
  // (`db`) is used because every per-row mutation below re-scopes by
  // BOTH `id` AND `org_id`; we never touch a row without its own
  // org_id in the predicate (issue #430 posture).
  const softDeleted = await db
    .select({
      id: orgBrandingAssets.id,
      orgId: orgBrandingAssets.orgId,
      originalKey: orgBrandingAssets.originalKey,
    })
    .from(orgBrandingAssets)
    .where(and(isNotNull(orgBrandingAssets.deletedAt), lt(orgBrandingAssets.deletedAt, grace)));

  let softDeletedReaped = 0;
  for (const row of softDeleted) {
    try {
      const prefix = prefixFromOriginalKey(row.originalKey);
      objectsDeleted += await deleteBrandingPrefix(prefix);
      await db
        .delete(orgBrandingAssets)
        // Issue #430 — explicit org filter even on a PK delete.
        .where(and(eq(orgBrandingAssets.id, row.id), eq(orgBrandingAssets.orgId, row.orgId)));
      softDeletedReaped += 1;
    } catch (err) {
      // Per-row failures don't abort the sweep — the row stays and the
      // next nightly run retries it.
      const message = err instanceof Error ? err.message : "Unknown error";
      log.warn({ assetId: row.id, orgId: row.orgId, err: message }, "soft-deleted reap failed");
    }
  }

  // ── Phase 2 — replaced / never-activated rows past grace ───────────
  // A row is an orphan when the tenant's active pointer does not (or no
  // longer does) reference it. `IS DISTINCT FROM` treats a NULL pointer
  // (logo removed, or tenant row gone) as "not pointing at this row".
  // The 7-day `updated_at` guard protects in-flight uploads: process /
  // activate flips touch `updated_at`, so anything younger than the
  // grace window is left alone.
  // CROSS-TENANT INTENTIONAL: same posture as Phase 1.
  const replaced = await db
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
        sql`${tenants.logoAssetId} IS DISTINCT FROM ${orgBrandingAssets.id}`,
      ),
    );

  let replacedReaped = 0;
  for (const row of replaced) {
    try {
      const prefix = prefixFromOriginalKey(row.originalKey);
      objectsDeleted += await deleteBrandingPrefix(prefix);
      await db
        .delete(orgBrandingAssets)
        // Issue #430 — explicit org filter even on a PK delete.
        .where(and(eq(orgBrandingAssets.id, row.id), eq(orgBrandingAssets.orgId, row.orgId)));
      replacedReaped += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.warn({ assetId: row.id, orgId: row.orgId, err: message }, "replaced reap failed");
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
          // object's LastModified as the grace clock.
          const newest = await newestBrandingObjectMtime(prefix);
          if (!newest || newest >= grace) continue;
          objectsDeleted += await deleteBrandingPrefix(prefix);
          unownedPrefixesReaped += 1;
          log.info({ prefix }, "unowned branding prefix reaped");
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
