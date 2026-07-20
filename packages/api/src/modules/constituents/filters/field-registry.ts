/**
 * Two-layer field registry (Epic #539, ADR-033 extension).
 *
 * The static core `FIELD_REGISTRY` is merged per request with the org's
 * `filterable` non-archived constituent-domain custom-field definitions,
 * each exposed under the dotted DSL name `custom.<key>`. The merged map
 * is what `FilterService` / `FilterQueryBuilder` resolve every field
 * lookup against — the DSL never carries column names or JSON keys.
 *
 * Definitions come from the 60s-cached catalog (`getActiveDefinitions`),
 * so the extra cost per filter request is one Redis GET. When the
 * `constituents.custom_fields` flag is off for the org, the merged
 * registry is exactly the static one — custom fields disappear from
 * validation, execution, catalog, suggestions, and sort in one move.
 *
 * Scope v1: constituent-domain definitions only (donation/campaign-domain
 * fields in the filter engine are out of the epic's MVP scope).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  CUSTOM_FIELD_KEY_PATTERN,
  type CustomFieldDefinition,
  type CustomFieldType,
} from "@givernance/shared/custom-fields";
import { customFieldDefinitions } from "@givernance/shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { withTenantContext } from "../../../lib/db.js";
import { flagService } from "../../../lib/flags/flag-service.js";
import { getActiveDefinitions } from "../../customization/lib/value-service.js";
import type { FieldMetadata, FilterOperator } from "./types.js";
import { FIELD_REGISTRY } from "./types.js";

export const CUSTOM_FIELD_DSL_PREFIX = "custom.";

/**
 * Operator vocabulary per definition type. isNull / isNotNull ("is empty" /
 * "has a value") are appended to every set below — custom values live in a
 * JSONB blob where the key is always optional, so presence checks are
 * meaningful for all of them.
 */
const OPERATORS_BY_TYPE: Record<CustomFieldType, FilterOperator[]> = {
  text: ["eq", "neq", "contains", "startsWith", "endsWith"],
  long_text: ["contains", "startsWith", "endsWith"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  currency: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  boolean: ["eq", "neq"],
  picklist: ["eq", "neq", "in"],
  multi_picklist: ["arrayContains", "arrayOverlaps"],
};

const PRESENCE_OPERATORS: FilterOperator[] = ["isNull", "isNotNull"];

/** DSL value-shape type per definition type (drives validation + FE input). */
const DSL_TYPE_BY_CUSTOM_TYPE: Record<CustomFieldType, FieldMetadata["type"]> = {
  text: "string",
  long_text: "string",
  number: "number",
  currency: "number",
  date: "date",
  boolean: "boolean",
  picklist: "string",
  multi_picklist: "array",
};

/**
 * Static category of each core field for the `/filter/fields` catalog —
 * mirrors the FE's hand-maintained `filterFields` grouping so the fetched
 * catalog merges over the static one without moving anything.
 */
export const CORE_FIELD_CATEGORIES: Record<
  string,
  "identity" | "demographics" | "donation_history"
> = {
  "constituent.firstName": "identity",
  "constituent.lastName": "identity",
  "constituent.email": "identity",
  "constituent.phone": "identity",
  "constituent.createdAt": "identity",
  "constituent.type": "demographics",
  "constituent.tags": "demographics",
  "address.city": "demographics",
  "address.postalCode": "demographics",
  "address.countryCode": "demographics",
  "donations.totalAmount": "donation_history",
  "donations.count": "donation_history",
  "donations.lastDate": "donation_history",
  "donations.firstDate": "donation_history",
};

/** Project one active definition into the registry's FieldMetadata shape. */
export function customFieldToMetadata(def: CustomFieldDefinition): FieldMetadata {
  return {
    name: `${CUSTOM_FIELD_DSL_PREFIX}${def.key}`,
    type: DSL_TYPE_BY_CUSTOM_TYPE[def.type],
    table: "constituents",
    column: "custom",
    operators: [...OPERATORS_BY_TYPE[def.type], ...PRESENCE_OPERATORS],
    ...(def.type === "currency" ? { valueUnit: "cents" as const } : {}),
    source: "custom",
    customType: def.type,
    jsonKey: def.key,
    label: def.label,
    category: "custom",
    sensitive: def.sensitive,
    ...(def.type === "picklist" || def.type === "multi_picklist"
      ? {
          options: def.options.map((option) => ({
            id: option.id,
            label: option.label,
            active: option.active,
          })),
        }
      : {}),
    nullable: true,
  };
}

export interface FieldRegistryBundle {
  registry: Record<string, FieldMetadata>;
  /**
   * DSL names (`custom.<key>`) of ARCHIVED constituent definitions —
   * lets `validateQuery` turn a persisted segment that references an
   * archived field into the named `custom_field_archived` 400 instead
   * of a generic "Unknown field" (never silently dropped).
   */
  archivedDslNames: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Merged per-org registry + archived-key set. One Redis GET on the warm
 * path plus one indexed SELECT for archived keys; both skipped entirely
 * when the org's custom-fields flag is off.
 */
export async function getFieldRegistryBundle(orgId: string): Promise<FieldRegistryBundle> {
  const customFieldsEnabled = await flagService.isEnabled(
    FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
    { orgId },
  );
  if (!customFieldsEnabled) {
    return { registry: FIELD_REGISTRY, archivedDslNames: EMPTY_SET };
  }

  const [defs, archivedDslNames] = await Promise.all([
    getActiveDefinitions(orgId, "constituent"),
    getArchivedDslNames(orgId),
  ]);

  const registry: Record<string, FieldMetadata> = { ...FIELD_REGISTRY };
  for (const def of defs) {
    // Defence-in-depth: the DB CHECK enforces the key shape, but the key is
    // interpolated into JSONB path expressions, so re-verify before it can
    // enter the registry at all.
    if (!def.filterable || !CUSTOM_FIELD_KEY_PATTERN.test(def.key)) continue;
    registry[`${CUSTOM_FIELD_DSL_PREFIX}${def.key}`] = customFieldToMetadata(def);
  }

  return { registry, archivedDslNames };
}

/** Convenience for callers that only need the merged map. */
export async function getFieldRegistry(orgId: string): Promise<Record<string, FieldMetadata>> {
  return (await getFieldRegistryBundle(orgId)).registry;
}

async function getArchivedDslNames(orgId: string): Promise<ReadonlySet<string>> {
  const rows = await withTenantContext(orgId, (tx) =>
    tx
      .select({ key: customFieldDefinitions.key })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.domain, "constituent"),
          isNotNull(customFieldDefinitions.archivedAt),
        ),
      ),
  );
  return new Set(rows.map((row) => `${CUSTOM_FIELD_DSL_PREFIX}${row.key}`));
}
