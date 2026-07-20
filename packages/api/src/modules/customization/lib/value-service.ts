/**
 * Custom-field value-service — the seam every domain module imports
 * (Epic #539). Owns the cached active-definition catalog and the three
 * operations the constituent / donation / campaign read+write paths
 * need: patch validation, definition-driven serialization, and the
 * projection-eligibility filter.
 *
 * Caching: Redis `customfields:{orgId}:{domain}`, TTL 60 s — deliberately
 * ≤ 1 minute so no operator-facing flush route is required (issue #449) —
 * plus `invalidateDefinitionsCache(orgId)` on every definition mutation
 * (including sensitive-flag toggles). The cache is best-effort: Redis
 * failures fall through to Postgres, never to a 500.
 *
 * Eligibility (`show_on_related ∧ ¬sensitive ∧ ¬archived`) is recomputed
 * on every `getProjectableDefinitions` call over the cached defs — never
 * baked into cached payloads or SSR props (Epic #539 anti-goal #9).
 */

import {
  buildCustomValidator,
  CUSTOM_FIELD_DOMAIN_VALUES,
  CUSTOM_FIELDS_CACHE_TTL_SECONDS,
  type CustomFieldDefinition,
  type CustomFieldDomain,
  type CustomFieldPatch,
  type CustomFieldValue,
  type CustomFieldValueError,
  type CustomFieldValues,
  customFieldsCacheKey,
  SHOW_ON_RELATED_HARD_CAP,
} from "@givernance/shared/custom-fields";
import { customFieldDefinitions } from "@givernance/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withTenantContext } from "../../../lib/db.js";
import { redis } from "../../../lib/redis.js";

function rowToDefinition(row: typeof customFieldDefinitions.$inferSelect): CustomFieldDefinition {
  return {
    id: row.id,
    domain: row.domain,
    key: row.key,
    label: row.label,
    description: row.description,
    type: row.type,
    options: row.options,
    sortOrder: row.sortOrder,
    required: row.required,
    filterable: row.filterable,
    exportable: row.exportable,
    showOnRelated: row.showOnRelated,
    sensitive: row.sensitive,
    purposeText: row.purposeText,
  };
}

/**
 * Active (non-archived) definitions of one (org × domain), admin-ordered.
 * Redis-cached 60 s; cache errors degrade to a direct DB read.
 */
export async function getActiveDefinitions(
  orgId: string,
  domain: CustomFieldDomain,
): Promise<CustomFieldDefinition[]> {
  const cacheKey = customFieldsCacheKey(orgId, domain);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as CustomFieldDefinition[];
    }
  } catch {
    // Cache is best-effort — fall through to Postgres.
  }

  const rows = await withTenantContext(orgId, (tx) =>
    tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.domain, domain),
          isNull(customFieldDefinitions.archivedAt),
        ),
      )
      .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id)),
  );

  const defs = rows.map(rowToDefinition);

  try {
    await redis.set(cacheKey, JSON.stringify(defs), "EX", CUSTOM_FIELDS_CACHE_TTL_SECONDS);
  } catch {
    // Best-effort — a failed SET only costs the next request a DB read.
  }

  return defs;
}

/** A definition plus its archive state — the read-only serializer input. */
export interface ReadableDefinition extends CustomFieldDefinition {
  archived: boolean;
}

/**
 * Active PLUS archived definitions of one (org × domain) — the READ-ONLY
 * catalog for detail responses and the CSV/DSAR export, where archived
 * values stay visible (docs/35: "values retained, read-only on detail +
 * exports"). Never feed this to forms, filters, or write validation —
 * those stay on `getActiveDefinitions`. Uncached: detail + export are
 * low-frequency surfaces and the archived set has no invalidation hook.
 */
export async function getReadableDefinitions(
  orgId: string,
  domain: CustomFieldDomain,
): Promise<ReadableDefinition[]> {
  const rows = await withTenantContext(orgId, (tx) =>
    tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(eq(customFieldDefinitions.orgId, orgId), eq(customFieldDefinitions.domain, domain)),
      )
      .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id)),
  );
  // The unique index is partial (archived_at IS NULL), so an archived def
  // can coexist with an active re-creation of the same key. The blob holds
  // ONE value per key — the active definition owns it; the archived twin
  // is dropped here so the same value never renders twice.
  const activeKeys = new Set(rows.filter((row) => row.archivedAt === null).map((row) => row.key));
  // Active first (admin order), then archived — export columns keep a
  // stable, comprehensible layout.
  return rows
    .filter((row) => row.archivedAt === null || !activeKeys.has(row.key))
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null))
    .map((row) => ({ ...rowToDefinition(row), archived: row.archivedAt !== null }));
}

/**
 * Drops the cached catalog of every domain for one org. MUST be called
 * by every definition mutation (create / patch / archive / reorder /
 * option changes) — sensitive-flag toggles included, since projection
 * eligibility reads the cached `sensitive` bit.
 */
export async function invalidateDefinitionsCache(orgId: string): Promise<void> {
  const keys = CUSTOM_FIELD_DOMAIN_VALUES.map((domain) => customFieldsCacheKey(orgId, domain));
  try {
    await redis.unlink(...keys);
  } catch {
    // Best-effort — the 60 s TTL is the staleness backstop.
  }
}

export type ValidateCustomPatchResult =
  | { ok: true; merged: CustomFieldValues }
  | { ok: false; errors: CustomFieldValueError[] };

/**
 * Validates a `custom` merge-patch from a create/update payload against
 * the org's active catalog and applies it over the existing blob.
 * Explicit `null` clears a key; absent keys stay untouched; unknown or
 * archived keys, inactive options, and type mismatches come back as the
 * typed error list the route maps onto its 422 response.
 *
 * `enforceRequired: true` on create paths only — required is enforced
 * on new writes, never retro-blocking.
 */
export async function validateCustomPatch(
  orgId: string,
  domain: CustomFieldDomain,
  existing: CustomFieldValues,
  patch: CustomFieldPatch,
  options?: { enforceRequired?: boolean },
): Promise<ValidateCustomPatchResult> {
  const defs = await getActiveDefinitions(orgId, domain);
  return buildCustomValidator(defs).validatePatch(existing, patch, options);
}

/**
 * Definition-driven serializer: picks ONLY the given definitions' keys
 * out of a stored `custom` blob. This is the strict-response firewall —
 * whole-blob passthrough (or `additionalProperties: true` on anything
 * carrying custom values) is a blocking review finding (Epic #539
 * anti-goal #5). Callers choose the definition set per surface:
 * `getActiveDefinitions` for detail/forms, `getProjectableDefinitions`
 * for cross-domain projection, `exportable` subsets for CSV.
 */
export function buildCustomSerializer(
  defs: readonly CustomFieldDefinition[],
): (custom: unknown) => CustomFieldValues {
  const keys = defs.map((def) => def.key);
  return (custom: unknown): CustomFieldValues => {
    const out: CustomFieldValues = {};
    if (custom === null || typeof custom !== "object" || Array.isArray(custom)) {
      return out;
    }
    const blob = custom as Record<string, unknown>;
    for (const key of keys) {
      const value = blob[key];
      if (value !== undefined && value !== null) {
        out[key] = value as CustomFieldValue;
      }
    }
    return out;
  };
}

/**
 * Constituent definitions eligible for cross-domain projection onto
 * donation/campaign read models: `show_on_related ∧ ¬sensitive`
 * (¬archived is implied — archived defs never enter the active
 * catalog). Filtered per call over the 60 s-cached defs so a sensitive
 * toggle takes effect within one cache window at worst — and
 * immediately when the mutation path calls `invalidateDefinitionsCache`
 * as required. Capped at `SHOW_ON_RELATED_HARD_CAP` defensively; the
 * CRUD service enforces the cap at write time.
 */
export async function getProjectableDefinitions(orgId: string): Promise<CustomFieldDefinition[]> {
  const defs = await getActiveDefinitions(orgId, "constituent");
  return defs
    .filter((def) => def.showOnRelated && !def.sensitive)
    .slice(0, SHOW_ON_RELATED_HARD_CAP);
}
