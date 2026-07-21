/**
 * Customization service — per-org custom-field definitions, picklist
 * option lifecycle (add / rename-in-place / deactivate / merge), quota
 * enforcement, and the on-demand usage report (Epic #539, docs/35).
 *
 * Quotas resolve as: plan quota (shared limits) raised by any live
 * `customization_quota_overrides` row, capped at the platform ceiling.
 * Overrides are written super-admin-side only; here they are read-only
 * (SELECT-only grant for `givernance_app`).
 *
 * Every mutation writes a named audit action (definition/option metadata
 * gets full diffs — it is not PII; merge rows carry counts + ids only)
 * and drops the Redis catalog cache via `invalidateDefinitionsCache`.
 */

import { randomUUID } from "node:crypto";
import {
  CUSTOM_FIELD_KEY_PATTERN,
  CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS,
  CUSTOM_FIELD_QUOTA_CEILINGS,
  CUSTOM_FIELD_QUOTA_KEYS,
  CUSTOM_FIELDS_IMPORT_HEADER_PREFIX,
  type CustomFieldDomain,
  type CustomFieldOption,
  type CustomFieldQuotas,
  type CustomFieldType,
  generateOptionId,
  isReservedKey,
  resolveCustomFieldQuotas,
  SHOW_ON_RELATED_HARD_CAP,
} from "@givernance/shared/custom-fields";
import { CUSTOM_FIELD_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  auditLogs,
  type CustomFieldDefinitionRow,
  campaigns,
  constituents,
  customFieldDefinitions,
  customFieldMergeUndo,
  customizationQuotaOverrides,
  donations,
  outboxEvents,
  tenants,
} from "@givernance/shared/schema";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import { invalidateDefinitionsCache } from "./lib/value-service.js";

type Tx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

/**
 * Domain-conflict / validation failure the route maps onto an RFC 9457
 * body: `title` is the machine-readable code (snake_case, matching the
 * 422 matrix in docs/35), `extensions` the snake_case extras
 * (`quota_key`, `limit`, …).
 */
export class CustomFieldRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    message: string,
    public readonly extensions?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CustomFieldRequestError";
  }
}

/** Audit attribution forwarded from `request.auth` by the route layer. */
export interface AuditActor {
  /** Keycloak `sub` of the effective subject. */
  userId: string;
  /** Impersonating actor's `sub`, when different from the subject. */
  actorId: string | null;
  /** `users.id` row UUID — FK target for `created_by`. */
  userRowId: string | null;
}

const PICKLIST_TYPES: readonly CustomFieldType[] = ["picklist", "multi_picklist"];

/** Value-bearing table per domain. Constituents alone soft-delete. */
const DOMAIN_VALUE_TABLES = {
  constituent: constituents,
  donation: donations,
  campaign: campaigns,
} as const;

function liveRowsClause(domain: CustomFieldDomain) {
  return domain === "constituent" ? sql` AND deleted_at IS NULL` : sql.empty();
}

async function writeAudit(
  tx: Tx,
  orgId: string,
  actor: AuditActor,
  action: string,
  resourceId: string | null,
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null,
): Promise<void> {
  await tx.insert(auditLogs).values({
    orgId,
    userId: actor.userId,
    actorId: actor.actorId,
    action,
    resourceType: "custom_field",
    resourceId,
    oldValues,
    newValues,
  });
}

/**
 * Serialises read-modify-write sections per (org × scope): the
 * count-then-insert quota pattern is a TOCTOU race under read committed,
 * and the picklist `options` array is rebuilt from a read on every
 * option mutation (add / rename / merge / undo — an unserialised pair
 * can strip merge markers). These are rare admin-only mutations, so a
 * transaction-scoped advisory lock is the cheap fix. `scope` is the
 * domain for definition-level writes and the definition id for
 * option-level writes.
 */
async function acquireQuotaLock(tx: Tx, orgId: string, scope: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`custom_fields:${orgId}:${scope}`}))`,
  );
}

/** Postgres unique-violation (23505) — surfaces as 409 `duplicate_key`. */
function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

function quotaExceeded(quotaKey: string, limit: number, detail: string): CustomFieldRequestError {
  return new CustomFieldRequestError(422, "quota_exceeded", detail, {
    quota_key: quotaKey,
    limit,
  });
}

/**
 * Plan quota raised by live overrides, capped at the platform ceiling.
 * Overrides only ever RAISE (`Math.max`) — a row below the plan quota is
 * inert, so revoking an expired exception can't accidentally lower a
 * tenant below its plan.
 */
async function getEffectiveQuotas(
  tx: Tx,
  orgId: string,
  domain: CustomFieldDomain,
): Promise<CustomFieldQuotas> {
  const [tenant] = await tx
    .select({ plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, orgId));
  const effective = { ...resolveCustomFieldQuotas(tenant?.plan ?? "") };

  const overrides = await tx
    .select({
      domain: customizationQuotaOverrides.domain,
      quotaKey: customizationQuotaOverrides.quotaKey,
      value: customizationQuotaOverrides.value,
    })
    .from(customizationQuotaOverrides)
    .where(
      and(
        eq(customizationQuotaOverrides.orgId, orgId),
        or(
          isNull(customizationQuotaOverrides.domain),
          eq(customizationQuotaOverrides.domain, domain),
        ),
        or(
          isNull(customizationQuotaOverrides.expiresAt),
          gt(customizationQuotaOverrides.expiresAt, new Date()),
        ),
      ),
    );

  for (const override of overrides) {
    if (override.quotaKey === CUSTOM_FIELD_QUOTA_KEYS.FIELDS_PER_DOMAIN) {
      effective.fieldsPerDomain = Math.max(effective.fieldsPerDomain, override.value);
    } else if (override.quotaKey === CUSTOM_FIELD_QUOTA_KEYS.OPTIONS_PER_PICKLIST) {
      effective.optionsPerPicklist = Math.max(effective.optionsPerPicklist, override.value);
    } else if (override.quotaKey === CUSTOM_FIELD_QUOTA_KEYS.SHOW_ON_RELATED_FIELDS) {
      effective.showOnRelatedFields = Math.max(effective.showOnRelatedFields, override.value);
    }
  }

  effective.fieldsPerDomain = Math.min(
    effective.fieldsPerDomain,
    CUSTOM_FIELD_QUOTA_CEILINGS.fieldsPerDomain,
  );
  effective.optionsPerPicklist = Math.min(
    effective.optionsPerPicklist,
    CUSTOM_FIELD_QUOTA_CEILINGS.optionsPerPicklist,
  );
  effective.showOnRelatedFields = Math.min(
    effective.showOnRelatedFields,
    CUSTOM_FIELD_QUOTA_CEILINGS.showOnRelatedFields,
    SHOW_ON_RELATED_HARD_CAP,
  );
  return effective;
}

async function countActiveDefinitions(
  tx: Tx,
  orgId: string,
  domain: CustomFieldDomain,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.orgId, orgId),
        eq(customFieldDefinitions.domain, domain),
        isNull(customFieldDefinitions.archivedAt),
      ),
    );
  return Number(row?.count ?? 0);
}

async function countProjectedDefinitions(
  tx: Tx,
  orgId: string,
  excludeId?: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.orgId, orgId),
        eq(customFieldDefinitions.domain, "constituent"),
        isNull(customFieldDefinitions.archivedAt),
        eq(customFieldDefinitions.showOnRelated, true),
        excludeId ? ne(customFieldDefinitions.id, excludeId) : undefined,
      ),
    );
  return Number(row?.count ?? 0);
}

function assertKeyAllowed(key: string): void {
  if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) {
    throw new CustomFieldRequestError(
      422,
      "invalid_key",
      "Key must match ^[a-z][a-z0-9_]{1,62}$ (lowercase snake_case, starting with a letter)",
    );
  }
  if (isReservedKey(key)) {
    throw new CustomFieldRequestError(
      422,
      "reserved_key",
      `'${key}' collides with a core column, filter-DSL token, import alias, or reserved prefix`,
    );
  }
}

/**
 * A label starting with the `cf_` import alias prefix would collide with
 * another definition's stable import header and silently misroute its
 * column on re-import — rejected outright.
 */
function assertLabelAllowed(label: string): void {
  if (label.trim().toLowerCase().startsWith(CUSTOM_FIELDS_IMPORT_HEADER_PREFIX)) {
    throw new CustomFieldRequestError(
      422,
      "label_reserved_prefix",
      `Labels may not start with '${CUSTOM_FIELDS_IMPORT_HEADER_PREFIX}' — it is reserved for import header aliases`,
    );
  }
}

/**
 * `;` and `|` are the multi-picklist cell separators in CSV export /
 * import — a label containing either could never round-trip.
 */
function assertOptionLabelAllowed(label: string): void {
  if (/[;|]/.test(label)) {
    throw new CustomFieldRequestError(
      422,
      "invalid_option_label",
      "Option labels may not contain ';' or '|' (reserved as CSV multi-value separators)",
    );
  }
}

/** `undefined` = not in the patch; blank / null collapse to null. */
function normalizeNullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const AUDITABLE_DEFINITION_FIELDS = [
  "label",
  "description",
  "sortOrder",
  "required",
  "filterable",
  "exportable",
  "showOnRelated",
  "sensitive",
  "purposeText",
] as const;

function definitionDiff(
  prev: CustomFieldDefinitionRow,
  next: CustomFieldDefinitionRow,
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const field of AUDITABLE_DEFINITION_FIELDS) {
    if (prev[field] !== next[field]) {
      oldValues[field] = prev[field];
      newValues[field] = next[field];
    }
  }
  return { oldValues, newValues };
}

function assertPurpose(sensitive: boolean, purposeText: string | null): void {
  if (sensitive && (purposeText === null || purposeText.trim() === "")) {
    throw new CustomFieldRequestError(
      422,
      "purpose_required",
      "A sensitive (GDPR Art. 9) field must record its processing purpose",
    );
  }
}

function assertShowOnRelatedShape(
  showOnRelated: boolean,
  domain: CustomFieldDomain,
  sensitive: boolean,
): void {
  if (!showOnRelated) return;
  if (domain !== "constituent") {
    throw new CustomFieldRequestError(
      422,
      "show_on_related_invalid_domain",
      "Cross-domain projection is only available for constituent fields",
    );
  }
  if (sensitive) {
    throw new CustomFieldRequestError(
      422,
      "show_on_related_sensitive",
      "Sensitive (Art. 9) fields are structurally excluded from cross-domain projection",
    );
  }
}

function fieldsQuotaExceeded(
  quotas: CustomFieldQuotas,
  domain: CustomFieldDomain,
): CustomFieldRequestError {
  return quotaExceeded(
    CUSTOM_FIELD_QUOTA_KEYS.FIELDS_PER_DOMAIN,
    quotas.fieldsPerDomain,
    `The fields-per-domain quota (${quotas.fieldsPerDomain}) for '${domain}' is reached`,
  );
}

async function assertActiveKeyUnique(
  tx: Tx,
  orgId: string,
  domain: CustomFieldDomain,
  key: string,
): Promise<void> {
  const [duplicate] = await tx
    .select({ id: customFieldDefinitions.id })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.orgId, orgId),
        eq(customFieldDefinitions.domain, domain),
        eq(customFieldDefinitions.key, key),
        isNull(customFieldDefinitions.archivedAt),
      ),
    );
  if (duplicate) {
    throw new CustomFieldRequestError(
      409,
      "duplicate_key",
      `An active '${domain}' field with key '${key}' already exists`,
    );
  }
}

async function nextSortOrder(tx: Tx, orgId: string, domain: CustomFieldDomain): Promise<number> {
  const [maxRow] = await tx
    .select({ max: sql<number | null>`max(sort_order)` })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.orgId, orgId),
        eq(customFieldDefinitions.domain, domain),
        isNull(customFieldDefinitions.archivedAt),
      ),
    );
  return maxRow?.max === null || maxRow?.max === undefined ? 0 : Number(maxRow.max) + 1;
}

async function assertProjectionQuota(
  tx: Tx,
  orgId: string,
  quotas: CustomFieldQuotas,
  excludeId?: string,
): Promise<void> {
  const used = await countProjectedDefinitions(tx, orgId, excludeId);
  if (used >= quotas.showOnRelatedFields) {
    throw quotaExceeded(
      CUSTOM_FIELD_QUOTA_KEYS.SHOW_ON_RELATED_FIELDS,
      quotas.showOnRelatedFields,
      `The projected-fields quota (${quotas.showOnRelatedFields}) is reached`,
    );
  }
}

// ── Definitions CRUD ──

/**
 * Read-only lookup (archived rows included) — the route layer resolves
 * the row's domain BEFORE mutating so a switched-off domain flag 404s
 * without side effects. Cross-tenant ids miss the `eq(orgId)` predicate
 * and come back null → indistinguishable 404 (ADR-019).
 */
export async function getDefinition(
  orgId: string,
  id: string,
): Promise<CustomFieldDefinitionRow | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)));
    return row ?? null;
  });
}

export interface ListDefinitionsOptions {
  domains: CustomFieldDomain[];
  includeArchived?: boolean;
}

export async function listDefinitions(
  orgId: string,
  options: ListDefinitionsOptions,
): Promise<CustomFieldDefinitionRow[]> {
  if (options.domains.length === 0) {
    return [];
  }
  return withTenantContext(orgId, (tx) =>
    tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          inArray(customFieldDefinitions.domain, options.domains),
          options.includeArchived ? undefined : isNull(customFieldDefinitions.archivedAt),
        ),
      )
      .orderBy(
        asc(customFieldDefinitions.domain),
        asc(customFieldDefinitions.sortOrder),
        asc(customFieldDefinitions.id),
      ),
  );
}

export interface CreateDefinitionInput {
  domain: CustomFieldDomain;
  key: string;
  label: string;
  description?: string | null;
  type: CustomFieldType;
  options?: { label: string }[];
  sortOrder?: number;
  required?: boolean;
  filterable?: boolean;
  exportable?: boolean;
  showOnRelated?: boolean;
  sensitive?: boolean;
  purposeText?: string | null;
}

export async function createDefinition(
  orgId: string,
  actor: AuditActor,
  input: CreateDefinitionInput,
): Promise<CustomFieldDefinitionRow> {
  assertKeyAllowed(input.key);
  assertLabelAllowed(input.label);
  for (const option of input.options ?? []) {
    assertOptionLabelAllowed(option.label);
  }

  const sensitive = input.sensitive ?? false;
  const showOnRelated = input.showOnRelated ?? false;
  const purposeText = normalizeNullableText(input.purposeText) ?? null;
  assertPurpose(sensitive, purposeText);
  assertShowOnRelatedShape(showOnRelated, input.domain, sensitive);

  const isPicklist = PICKLIST_TYPES.includes(input.type);
  if (!isPicklist && input.options && input.options.length > 0) {
    throw new CustomFieldRequestError(
      422,
      "options_not_allowed",
      `'${input.type}' fields do not carry options`,
    );
  }

  const created = await withTenantContext(orgId, async (tx) => {
    await acquireQuotaLock(tx, orgId, input.domain);
    const quotas = await getEffectiveQuotas(tx, orgId, input.domain);

    const activeCount = await countActiveDefinitions(tx, orgId, input.domain);
    if (activeCount >= quotas.fieldsPerDomain) {
      throw quotaExceeded(
        CUSTOM_FIELD_QUOTA_KEYS.FIELDS_PER_DOMAIN,
        quotas.fieldsPerDomain,
        `The fields-per-domain quota (${quotas.fieldsPerDomain}) for '${input.domain}' is reached`,
      );
    }

    const optionInputs = input.options ?? [];
    if (optionInputs.length > quotas.optionsPerPicklist) {
      throw quotaExceeded(
        CUSTOM_FIELD_QUOTA_KEYS.OPTIONS_PER_PICKLIST,
        quotas.optionsPerPicklist,
        `The options-per-picklist quota (${quotas.optionsPerPicklist}) is exceeded`,
      );
    }

    if (showOnRelated) {
      await assertProjectionQuota(tx, orgId, quotas);
    }

    await assertActiveKeyUnique(tx, orgId, input.domain, input.key);
    const sortOrder = input.sortOrder ?? (await nextSortOrder(tx, orgId, input.domain));

    const options: CustomFieldOption[] = optionInputs.map((option, index) => ({
      id: generateOptionId(),
      label: option.label.trim(),
      active: true,
      sortOrder: index,
    }));

    const [row] = await tx
      .insert(customFieldDefinitions)
      .values({
        orgId,
        domain: input.domain,
        key: input.key,
        label: input.label.trim(),
        description: normalizeNullableText(input.description) ?? null,
        type: input.type,
        options,
        sortOrder,
        required: input.required ?? false,
        filterable: input.filterable ?? true,
        exportable: input.exportable ?? true,
        showOnRelated,
        sensitive,
        purposeText,
        createdBy: actor.userRowId,
      })
      .returning();
    if (!row) {
      throw new Error("custom field insert returned no row");
    }

    await writeAudit(tx, orgId, actor, "custom_field.created", row.id, null, {
      domain: row.domain,
      key: row.key,
      label: row.label,
      type: row.type,
      required: row.required,
      filterable: row.filterable,
      exportable: row.exportable,
      showOnRelated: row.showOnRelated,
      sensitive: row.sensitive,
      optionCount: row.options.length,
    });

    return row;
  }).catch((error: unknown) => {
    // The advisory lock serialises same-org writers; a concurrent create
    // that raced from ANOTHER path still surfaces as the named 409, never
    // a raw 23505 → 500.
    if (isUniqueViolation(error)) {
      throw new CustomFieldRequestError(
        409,
        "duplicate_key",
        `An active '${input.domain}' field with key '${input.key}' already exists`,
      );
    }
    throw error;
  });

  await invalidateDefinitionsCache(orgId);
  return created;
}

export interface UpdateDefinitionInput {
  label?: string;
  description?: string | null;
  sortOrder?: number;
  required?: boolean;
  filterable?: boolean;
  exportable?: boolean;
  showOnRelated?: boolean;
  sensitive?: boolean;
  purposeText?: string | null;
}

async function getActiveRow(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CustomFieldDefinitionRow | null> {
  const [row] = await tx
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.id, id),
        eq(customFieldDefinitions.orgId, orgId),
        isNull(customFieldDefinitions.archivedAt),
      ),
    );
  return row ?? null;
}

export async function updateDefinition(
  orgId: string,
  actor: AuditActor,
  id: string,
  input: UpdateDefinitionInput,
): Promise<CustomFieldDefinitionRow | null> {
  if (input.label !== undefined) {
    assertLabelAllowed(input.label);
  }
  const updated = await withTenantContext(orgId, async (tx) => {
    const row = await getActiveRow(tx, orgId, id);
    if (!row) return null;

    const sensitive = input.sensitive ?? row.sensitive;
    const showOnRelated = input.showOnRelated ?? row.showOnRelated;
    const purposePatch = normalizeNullableText(input.purposeText);
    const purposeText = purposePatch === undefined ? row.purposeText : purposePatch;
    assertPurpose(sensitive, purposeText);
    assertShowOnRelatedShape(showOnRelated, row.domain, sensitive);

    if (showOnRelated && !row.showOnRelated) {
      await acquireQuotaLock(tx, orgId, row.domain);
      const quotas = await getEffectiveQuotas(tx, orgId, row.domain);
      await assertProjectionQuota(tx, orgId, quotas, row.id);
    }

    const [next] = await tx
      .update(customFieldDefinitions)
      .set({
        label: input.label?.trim(),
        description: normalizeNullableText(input.description),
        sortOrder: input.sortOrder,
        required: input.required,
        filterable: input.filterable,
        exportable: input.exportable,
        showOnRelated: input.showOnRelated,
        sensitive: input.sensitive,
        purposeText: purposePatch,
        updatedAt: new Date(),
      })
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)))
      .returning();
    if (!next) return null;

    const { oldValues, newValues } = definitionDiff(row, next);
    await writeAudit(tx, orgId, actor, "custom_field.updated", id, oldValues, newValues);

    return next;
  });

  await invalidateDefinitionsCache(orgId);
  return updated;
}

/** Soft-archive: hidden from forms/filters/columns; values retained. */
export async function archiveDefinition(
  orgId: string,
  actor: AuditActor,
  id: string,
): Promise<CustomFieldDefinitionRow | null> {
  const archived = await withTenantContext(orgId, async (tx) => {
    const row = await getActiveRow(tx, orgId, id);
    if (!row) return null;

    const [next] = await tx
      .update(customFieldDefinitions)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)))
      .returning();
    if (!next) return null;

    await writeAudit(tx, orgId, actor, "custom_field.archived", id, null, {
      domain: row.domain,
      key: row.key,
    });
    return next;
  });

  await invalidateDefinitionsCache(orgId);
  return archived;
}

/**
 * Un-archives a definition. Re-checks the fields quota (the definition
 * re-enters the count) and the active-key uniqueness — the same key may
 * have been re-created since (the type-change path).
 */
export async function restoreDefinition(
  orgId: string,
  actor: AuditActor,
  id: string,
): Promise<CustomFieldDefinitionRow | null> {
  const restored = await withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)));
    if (!row || row.archivedAt === null) return null;

    await acquireQuotaLock(tx, orgId, row.domain);
    const quotas = await getEffectiveQuotas(tx, orgId, row.domain);
    const activeCount = await countActiveDefinitions(tx, orgId, row.domain);
    if (activeCount >= quotas.fieldsPerDomain) {
      throw fieldsQuotaExceeded(quotas, row.domain);
    }

    await assertActiveKeyUnique(tx, orgId, row.domain, row.key);

    if (row.showOnRelated) {
      await assertProjectionQuota(tx, orgId, quotas, row.id);
    }

    const [next] = await tx
      .update(customFieldDefinitions)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)))
      .returning();
    if (!next) return null;

    await writeAudit(tx, orgId, actor, "custom_field.restored", id, null, {
      domain: row.domain,
      key: row.key,
    });
    return next;
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw new CustomFieldRequestError(
        409,
        "duplicate_key",
        "An active field with the same key already exists in this domain",
      );
    }
    throw error;
  });

  await invalidateDefinitionsCache(orgId);
  return restored;
}

/**
 * Bulk sort_order rewrite for one domain. `ids` must be exactly the set
 * of active definitions of that (org × domain) — a partial or stale list
 * is a 422, never a silent partial reorder.
 */
export async function reorderDefinitions(
  orgId: string,
  actor: AuditActor,
  domain: CustomFieldDomain,
  ids: string[],
): Promise<CustomFieldDefinitionRow[]> {
  const rows = await withTenantContext(orgId, async (tx) => {
    const active = await tx
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.domain, domain),
          isNull(customFieldDefinitions.archivedAt),
        ),
      );
    const activeIds = new Set(active.map((row) => row.id));
    const providedIds = new Set(ids);
    const exactCover =
      activeIds.size === providedIds.size &&
      providedIds.size === ids.length &&
      ids.every((id) => activeIds.has(id));
    if (!exactCover) {
      throw new CustomFieldRequestError(
        422,
        "reorder_mismatch",
        `'ids' must list every active '${domain}' definition exactly once`,
      );
    }

    for (const [index, id] of ids.entries()) {
      await tx
        .update(customFieldDefinitions)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)));
    }

    await writeAudit(tx, orgId, actor, "custom_field.reordered", null, null, {
      domain,
      count: ids.length,
    });

    return tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.domain, domain),
          isNull(customFieldDefinitions.archivedAt),
        ),
      )
      .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id));
  });

  await invalidateDefinitionsCache(orgId);
  return rows;
}

// ── Picklist options ──

function assertPicklistRow(row: CustomFieldDefinitionRow): void {
  if (!PICKLIST_TYPES.includes(row.type)) {
    throw new CustomFieldRequestError(
      422,
      "not_a_picklist",
      `'${row.key}' is a '${row.type}' field — it has no options`,
    );
  }
}

export async function addOption(
  orgId: string,
  actor: AuditActor,
  definitionId: string,
  label: string,
): Promise<CustomFieldDefinitionRow | null> {
  assertOptionLabelAllowed(label);
  const updated = await withTenantContext(orgId, async (tx) => {
    // Locked BEFORE the row read: the options array is read-modify-write,
    // so the lock guards both the per-picklist quota and the array itself.
    await acquireQuotaLock(tx, orgId, definitionId);
    const row = await getActiveRow(tx, orgId, definitionId);
    if (!row) return null;
    assertPicklistRow(row);

    const quotas = await getEffectiveQuotas(tx, orgId, row.domain);
    if (row.options.length >= quotas.optionsPerPicklist) {
      throw quotaExceeded(
        CUSTOM_FIELD_QUOTA_KEYS.OPTIONS_PER_PICKLIST,
        quotas.optionsPerPicklist,
        `The options-per-picklist quota (${quotas.optionsPerPicklist}) for '${row.key}' is reached`,
      );
    }

    const option: CustomFieldOption = {
      id: generateOptionId(),
      label: label.trim(),
      active: true,
      sortOrder: row.options.reduce((max, o) => Math.max(max, o.sortOrder + 1), 0),
    };
    const [next] = await tx
      .update(customFieldDefinitions)
      .set({ options: [...row.options, option], updatedAt: new Date() })
      .where(
        and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, orgId)),
      )
      .returning();
    if (!next) return null;

    await writeAudit(tx, orgId, actor, "custom_field.option_added", definitionId, null, {
      key: row.key,
      optionId: option.id,
      label: option.label,
    });
    return next;
  });

  await invalidateDefinitionsCache(orgId);
  return updated;
}

export interface UpdateOptionInput {
  label?: string;
  active?: boolean;
  sortOrder?: number;
}

export async function updateOption(
  orgId: string,
  actor: AuditActor,
  definitionId: string,
  optionId: string,
  input: UpdateOptionInput,
): Promise<CustomFieldDefinitionRow | null> {
  if (input.label !== undefined) {
    assertOptionLabelAllowed(input.label);
  }
  const updated = await withTenantContext(orgId, async (tx) => {
    // Same per-definition advisory lock as addOption: the options array is
    // read-modify-write, so an unserialised rename racing a merge would
    // rebuild the array from a stale read and strip its merge markers.
    await acquireQuotaLock(tx, orgId, definitionId);
    const row = await getActiveRow(tx, orgId, definitionId);
    if (!row) return null;
    assertPicklistRow(row);

    const option = row.options.find((candidate) => candidate.id === optionId);
    if (!option) return null;
    if (input.active === true && option.mergedInto) {
      throw new CustomFieldRequestError(
        422,
        "option_merged",
        `Option '${optionId}' was merged into '${option.mergedInto}' and cannot be reactivated`,
      );
    }

    const nextOption: CustomFieldOption = {
      ...option,
      label: input.label !== undefined ? input.label.trim() : option.label,
      active: input.active ?? option.active,
      sortOrder: input.sortOrder ?? option.sortOrder,
    };
    const options = row.options.map((candidate) =>
      candidate.id === optionId ? nextOption : candidate,
    );
    const [next] = await tx
      .update(customFieldDefinitions)
      .set({ options, updatedAt: new Date() })
      .where(
        and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, orgId)),
      )
      .returning();
    if (!next) return null;

    const action =
      input.active === false
        ? "custom_field.option_deactivated"
        : input.label !== undefined
          ? "custom_field.option_renamed"
          : "custom_field.updated";
    await writeAudit(
      tx,
      orgId,
      actor,
      action,
      definitionId,
      { optionId, label: option.label, active: option.active, sortOrder: option.sortOrder },
      {
        optionId,
        label: nextOption.label,
        active: nextOption.active,
        sortOrder: nextOption.sortOrder,
      },
    );
    return next;
  });

  await invalidateDefinitionsCache(orgId);
  return updated;
}

// ── Option merge ──

export interface MergeOptionResult {
  definition: CustomFieldDefinitionRow;
  affectedCount: number;
  /** Null on dry-run. */
  mergeId: string | null;
  /** Null on dry-run — end of the 30-day undo window (ISO). */
  undoExpiresAt: string | null;
  key: string;
  fieldType: "picklist" | "multi_picklist";
}

async function countRowsHoldingOption(
  tx: Tx,
  orgId: string,
  domain: CustomFieldDomain,
  fieldType: "picklist" | "multi_picklist",
  key: string,
  optionId: string,
): Promise<number> {
  const table = DOMAIN_VALUE_TABLES[domain];
  // `@>` containment is exactly what the jsonb_path_ops GIN indexes serve.
  const needle =
    fieldType === "picklist"
      ? JSON.stringify({ [key]: optionId })
      : JSON.stringify({ [key]: [optionId] });
  const result = await tx.execute<{ c: number }>(sql`
    SELECT count(*)::int AS c
    FROM ${table}
    WHERE org_id = ${orgId}
      AND custom @> ${needle}::jsonb
      ${liveRowsClause(domain)}
  `);
  return Number(result.rows[0]?.c ?? 0);
}

function undoWindowEnd(from: Date): Date {
  return new Date(from.getTime() + CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Dry-run: counts affected rows only. Real merge: marks the source
 * option `{active: false, mergedInto: target}` synchronously (new
 * writes of the source id are rejected immediately) and emits the
 * `custom_field.option_merge_requested` outbox row IN THE SAME
 * TRANSACTION — the relay enqueues the chunked backfill job (which
 * rewrites stored values and writes the TTL'd undo rows), so a Redis
 * outage can never strand a half-merged option without a backfill.
 */
export async function mergeOption(
  orgId: string,
  actor: AuditActor,
  definitionId: string,
  sourceOptionId: string,
  targetOptionId: string,
  options: { dryRun: boolean },
): Promise<MergeOptionResult | null> {
  const result = await withTenantContext(orgId, async (tx) => {
    // Serialise against every other option mutation of this definition
    // (add / rename / undo) — a concurrent writer rebuilding the options
    // array from a pre-merge read would strip the merge marker stamped
    // below, permanently orphaning the backfill job.
    await acquireQuotaLock(tx, orgId, definitionId);
    const row = await getActiveRow(tx, orgId, definitionId);
    if (!row) return null;
    assertPicklistRow(row);
    const fieldType = row.type as "picklist" | "multi_picklist";

    const source = row.options.find((candidate) => candidate.id === sourceOptionId);
    if (!source) return null;
    if (source.mergedInto) {
      throw new CustomFieldRequestError(
        422,
        "option_merged",
        `Option '${sourceOptionId}' was already merged into '${source.mergedInto}'`,
      );
    }
    const target = row.options.find((candidate) => candidate.id === targetOptionId);
    if (!target || target.id === source.id || !target.active) {
      throw new CustomFieldRequestError(
        422,
        "merge_target_invalid",
        "The merge target must be a different, active option of the same field",
      );
    }

    const affectedCount = await countRowsHoldingOption(
      tx,
      orgId,
      row.domain,
      fieldType,
      row.key,
      sourceOptionId,
    );

    if (options.dryRun) {
      return {
        definition: row,
        affectedCount,
        mergeId: null,
        undoExpiresAt: null,
        key: row.key,
        fieldType,
      };
    }

    const mergeId = randomUUID();
    const mergedAt = new Date();
    const nextOptions = row.options.map((candidate) =>
      candidate.id === sourceOptionId
        ? {
            ...candidate,
            active: false,
            mergedInto: targetOptionId,
            mergeId,
            mergedAt: mergedAt.toISOString(),
          }
        : candidate,
    );
    const [next] = await tx
      .update(customFieldDefinitions)
      .set({ options: nextOptions, updatedAt: new Date() })
      .where(
        and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, orgId)),
      )
      .returning();
    if (!next) return null;

    // Counts + ids only — pre-merge values live in custom_field_merge_undo.
    await writeAudit(tx, orgId, actor, "custom_field.option_merged", definitionId, null, {
      key: row.key,
      mergeId,
      sourceOptionId,
      targetOptionId,
      affectedCount,
    });

    // Transactional handoff to the backfill worker: the relay routes this
    // onto CUSTOM_FIELDS_QUEUE with the deterministic `option-merge-{mergeId}`
    // jobId, so redeliveries collapse instead of double-rewriting.
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: CUSTOM_FIELD_EVENT_TYPES.OPTION_MERGE_REQUESTED,
      payload: {
        mergeId,
        definitionId,
        sourceOptionId,
        targetOptionId,
        requestedBy: actor.userId || null,
      },
    });

    return {
      definition: next,
      affectedCount,
      mergeId,
      undoExpiresAt: undoWindowEnd(mergedAt).toISOString(),
      key: row.key,
      fieldType,
    };
  });

  await invalidateDefinitionsCache(orgId);
  return result;
}

export interface UndoMergeResult {
  definition: CustomFieldDefinitionRow;
  mergeId: string;
}

/**
 * Reverts an executed option merge inside the 30-day undo window:
 * re-activates the source option (clearing `mergedInto` / `mergeId` /
 * `mergedAt`) and emits the `custom_field.option_merge_undo_requested`
 * outbox row in the same transaction — the worker restores each
 * entity's pre-merge value from `custom_field_merge_undo` and deletes
 * the rows as it goes. The window is bounded by the option's `mergedAt`
 * stamp, so a purged undo store can never let an expired undo
 * re-activate the option while values stay silently rewritten.
 */
export async function undoOptionMerge(
  orgId: string,
  actor: AuditActor,
  definitionId: string,
  sourceOptionId: string,
  mergeId: string,
): Promise<UndoMergeResult | null> {
  const result = await withTenantContext(orgId, async (tx) => {
    // Same per-definition advisory lock as addOption/mergeOption — option
    // mutations on one definition must serialise (read-modify-write array).
    await acquireQuotaLock(tx, orgId, definitionId);
    const row = await getActiveRow(tx, orgId, definitionId);
    if (!row) return null;
    assertPicklistRow(row);

    const source = row.options.find((candidate) => candidate.id === sourceOptionId);
    if (!source) return null;
    if (!source.mergedInto || source.mergeId !== mergeId) {
      throw new CustomFieldRequestError(
        422,
        "merge_not_undoable",
        `Option '${sourceOptionId}' has no revertible merge '${mergeId}'`,
      );
    }
    const mergedAt = source.mergedAt ? new Date(source.mergedAt) : null;
    if (!mergedAt || Number.isNaN(mergedAt.getTime()) || undoWindowEnd(mergedAt) < new Date()) {
      throw new CustomFieldRequestError(
        422,
        "undo_expired",
        `The ${CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS}-day undo window for merge '${mergeId}' has ended`,
      );
    }
    const targetOptionId = source.mergedInto;

    // The undo store may legitimately be empty (zero-affected merge, or the
    // backfill hasn't run yet — its rows arrive before any rewrite, chunk by
    // chunk, so whatever WAS rewritten always has its row).
    const [undoRows] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(customFieldMergeUndo)
      .where(and(eq(customFieldMergeUndo.orgId, orgId), eq(customFieldMergeUndo.mergeId, mergeId)));

    const nextOptions = row.options.map((candidate) => {
      if (candidate.id !== sourceOptionId) return candidate;
      const { mergedInto: _m, mergeId: _i, mergedAt: _a, ...rest } = candidate;
      return { ...rest, active: true };
    });
    const [next] = await tx
      .update(customFieldDefinitions)
      .set({ options: nextOptions, updatedAt: new Date() })
      .where(
        and(eq(customFieldDefinitions.id, definitionId), eq(customFieldDefinitions.orgId, orgId)),
      )
      .returning();
    if (!next) return null;

    await writeAudit(tx, orgId, actor, "custom_field.option_merge_undone", definitionId, null, {
      key: row.key,
      mergeId,
      sourceOptionId,
      targetOptionId,
      undoRows: Number(undoRows?.count ?? 0),
    });

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: CUSTOM_FIELD_EVENT_TYPES.OPTION_MERGE_UNDO_REQUESTED,
      payload: {
        mergeId,
        definitionId,
        sourceOptionId,
        targetOptionId,
        requestedBy: actor.userId || null,
      },
    });

    return { definition: next, mergeId };
  });

  await invalidateDefinitionsCache(orgId);
  return result;
}

// ── Usage report ──

/** Counts 1–4 render as '< 5' (k-anonymity floor on admin surfaces). */
function maskCount(count: number): string {
  return count > 0 && count < 5 ? "< 5" : String(count);
}

export interface UsageOption {
  id: string;
  label: string;
  active: boolean;
  count: string;
}

export interface UsageField {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  sortOrder: number;
  filled: string;
  fillRatePercent: number | null;
  options: UsageOption[];
}

export interface UsageDomain {
  domain: CustomFieldDomain;
  totalRows: number;
  quotas: {
    fieldsPerDomain: { limit: number; used: number };
    optionsPerPicklist: { limit: number };
    showOnRelatedFields: { limit: number; used: number };
  };
  fields: UsageField[];
}

async function optionCounts(
  tx: Tx,
  orgId: string,
  domain: CustomFieldDomain,
  fieldType: "picklist" | "multi_picklist",
  key: string,
): Promise<Map<string, number>> {
  const table = DOMAIN_VALUE_TABLES[domain];
  const result =
    fieldType === "picklist"
      ? await tx.execute<{ option_id: string; c: number }>(sql`
          SELECT custom->>${key} AS option_id, count(*)::int AS c
          FROM ${table}
          WHERE org_id = ${orgId}
            AND custom ? ${key}
            ${liveRowsClause(domain)}
          GROUP BY 1
        `)
      : await tx.execute<{ option_id: string; c: number }>(sql`
          SELECT opt AS option_id, count(*)::int AS c
          FROM ${table}, jsonb_array_elements_text(custom->${key}) AS opt
          WHERE org_id = ${orgId}
            AND custom ? ${key}
            AND jsonb_typeof(custom->${key}) = 'array'
            ${liveRowsClause(domain)}
          GROUP BY 1
        `);
  return new Map(result.rows.map((row) => [row.option_id, Number(row.c)]));
}

/**
 * On-demand fill-rate + per-option counts for the settings page. Small
 * per-definition queries (≤ 50 defs by quota ceiling) — an occasional
 * admin read, not a hot path. `fillRatePercent` is withheld whenever the
 * filled count is masked, so the rate can't be inverted back below k.
 */
export async function getUsage(
  orgId: string,
  domains: CustomFieldDomain[],
): Promise<UsageDomain[]> {
  return withTenantContext(orgId, async (tx) => {
    const report: UsageDomain[] = [];
    for (const domain of domains) {
      const table = DOMAIN_VALUE_TABLES[domain];
      const quotas = await getEffectiveQuotas(tx, orgId, domain);
      const defs = await tx
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.orgId, orgId),
            eq(customFieldDefinitions.domain, domain),
            isNull(customFieldDefinitions.archivedAt),
          ),
        )
        .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id));

      const totalResult = await tx.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM ${table}
        WHERE org_id = ${orgId} ${liveRowsClause(domain)}
      `);
      const totalRows = Number(totalResult.rows[0]?.c ?? 0);

      const fields: UsageField[] = [];
      for (const def of defs) {
        const filledResult = await tx.execute<{ c: number }>(sql`
          SELECT count(*)::int AS c FROM ${table}
          WHERE org_id = ${orgId}
            AND custom ? ${def.key}
            ${liveRowsClause(domain)}
        `);
        const filled = Number(filledResult.rows[0]?.c ?? 0);
        const masked = filled > 0 && filled < 5;

        let optionUsage: UsageOption[] = [];
        if (PICKLIST_TYPES.includes(def.type)) {
          const counts = await optionCounts(
            tx,
            orgId,
            domain,
            def.type as "picklist" | "multi_picklist",
            def.key,
          );
          optionUsage = def.options.map((option) => ({
            id: option.id,
            label: option.label,
            active: option.active,
            count: maskCount(counts.get(option.id) ?? 0),
          }));
        }

        fields.push({
          id: def.id,
          key: def.key,
          label: def.label,
          type: def.type,
          sortOrder: def.sortOrder,
          filled: maskCount(filled),
          fillRatePercent:
            masked || totalRows === 0 ? null : Math.round((filled / totalRows) * 100),
          options: optionUsage,
        });
      }

      report.push({
        domain,
        totalRows,
        quotas: {
          fieldsPerDomain: { limit: quotas.fieldsPerDomain, used: defs.length },
          optionsPerPicklist: { limit: quotas.optionsPerPicklist },
          showOnRelatedFields: {
            limit: quotas.showOnRelatedFields,
            used: defs.filter((def) => def.showOnRelated).length,
          },
        },
        fields,
      });
    }
    return report;
  });
}
