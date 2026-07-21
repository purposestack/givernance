/**
 * Dynamic filter-field catalog (Epic #539 §5).
 *
 * The static `filterFields` mirror stays the source of truth for CORE fields
 * (labels are i18n keys, rendering is byte-for-byte what it was). Per-org
 * CUSTOM fields (`custom.<key>`, `category: "custom"`, `labelKind:
 * "literal"`) arrive from two places, in preference order:
 *
 *   1. `GET /v1/constituents/filter/fields` — the enriched server catalog
 *      (authoritative: it reflects the merged BE field registry, so a field
 *      shown here is guaranteed to validate + execute).
 *   2. A client-side projection of the SSR-fetched definition catalog
 *      (fallback when the endpoint is unreachable or not yet enriched).
 *
 * On any failure the builder degrades to the static catalog alone — core
 * filtering must never break because the custom layer is unavailable.
 */

import type { CustomFieldDefinition, CustomFieldType } from "@givernance/shared/custom-fields";
import type { ApiClient } from "@/lib/api";
import type { FilterField, FilterFieldType, FilterOperator } from "./filter-types";

/** Mirrors the BE `OPERATORS_BY_TYPE` in `filters/field-registry.ts` — a FE
 * offer the BE rejects would 400 on apply, so the two must stay in step. */
const OPERATORS_BY_CUSTOM_TYPE: Record<CustomFieldType, FilterOperator[]> = {
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

/**
 * Raw definition type → FE input widget. Exported: the donations catalog
 * (`donations/filters/donation-filter-catalog.ts`) translates its custom
 * entries through the SAME map so the two surfaces can never drift.
 */
export const UI_TYPE_BY_CUSTOM_TYPE: Record<CustomFieldType, FilterFieldType> = {
  text: "text",
  long_text: "text",
  number: "number",
  currency: "number",
  date: "date",
  boolean: "boolean",
  picklist: "select",
  multi_picklist: "multiselect",
};

const VALID_OPERATORS = new Set<FilterOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "contains",
  "startsWith",
  "endsWith",
  "arrayContains",
  "arrayOverlaps",
  "isNull",
  "isNotNull",
]);

const VALID_UI_TYPES = new Set<FilterFieldType>([
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "boolean",
]);

/**
 * Client-side projection of one active definition into a builder field —
 * the fetch-failure fallback. Returns null for non-filterable definitions.
 */
export function customFieldToFilterField(def: CustomFieldDefinition): FilterField | null {
  if (!def.filterable) return null;
  return {
    name: `custom.${def.key}`,
    label: def.label,
    labelKind: "literal",
    type: UI_TYPE_BY_CUSTOM_TYPE[def.type],
    category: "custom",
    operators: [...OPERATORS_BY_CUSTOM_TYPE[def.type], ...PRESENCE_OPERATORS],
    ...(def.type === "picklist" || def.type === "multi_picklist"
      ? {
          options: def.options
            .filter((o) => o.active)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((o) => ({ value: o.id, label: o.label })),
        }
      : {}),
  };
}

interface RawCatalogField {
  name?: unknown;
  label?: unknown;
  labelKind?: unknown;
  category?: unknown;
  type?: unknown;
  uiType?: unknown;
  operators?: unknown;
  options?: unknown;
}

/** BE DSL value-shape → FE input type, when no explicit `uiType` is sent. */
function uiTypeFromDslType(type: unknown): FilterFieldType | null {
  switch (type) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    case "array":
      return "multiselect";
    default:
      return null;
  }
}

/**
 * Map one enriched-catalog entry with `category: "custom"` onto a builder
 * field. Core entries (and anything malformed) return null — core fields
 * always render from the static catalog so their i18n labels, options, and
 * placeholders stay identical.
 */
function mapFetchedCustomField(raw: RawCatalogField): FilterField | null {
  if (raw.category !== "custom") return null;
  if (typeof raw.name !== "string" || !raw.name.startsWith("custom.")) return null;
  if (typeof raw.label !== "string" || raw.label.length === 0) return null;
  const operators = Array.isArray(raw.operators)
    ? (raw.operators.filter(
        (op): op is FilterOperator =>
          typeof op === "string" && VALID_OPERATORS.has(op as FilterOperator),
      ) as FilterOperator[])
    : [];
  if (operators.length === 0) return null;
  // The server's `uiType` is the raw DEFINITION type ('picklist',
  // 'currency', …) — translate it through the same map as the fallback
  // path before accepting it, otherwise 'picklist' fails the FE-type
  // check and degrades to a free-text input whose typed label can never
  // match the stored `opt_*` ids.
  const translatedUiType =
    typeof raw.uiType === "string" && raw.uiType in UI_TYPE_BY_CUSTOM_TYPE
      ? UI_TYPE_BY_CUSTOM_TYPE[raw.uiType as CustomFieldType]
      : raw.uiType;
  const uiType =
    typeof translatedUiType === "string" && VALID_UI_TYPES.has(translatedUiType as FilterFieldType)
      ? (translatedUiType as FilterFieldType)
      : uiTypeFromDslType(raw.type);
  if (!uiType) return null;

  const options = Array.isArray(raw.options)
    ? raw.options
        .filter(
          (o): o is { id: string; label: string; active?: boolean } =>
            typeof o === "object" &&
            o !== null &&
            typeof (o as { id?: unknown }).id === "string" &&
            typeof (o as { label?: unknown }).label === "string",
        )
        .filter((o) => o.active !== false)
        .map((o) => ({ value: o.id, label: o.label }))
    : undefined;

  return {
    name: raw.name,
    label: raw.label,
    labelKind: "literal",
    type: uiType,
    category: "custom",
    operators,
    ...(options && options.length > 0 ? { options } : {}),
  };
}

/**
 * Fetch the enriched `/filter/fields` catalog and extract the custom-field
 * entries. `null` = fetch failed OR the payload carries no custom entries
 * (endpoint not yet enriched) — callers then fall back to the client-side
 * projection.
 */
export async function fetchCustomFilterFields(client: ApiClient): Promise<FilterField[] | null> {
  try {
    const response = await client.get<{ data: { fields?: unknown } }>(
      "/v1/constituents/filter/fields",
    );
    const rawFields = response.data?.fields;
    if (!Array.isArray(rawFields)) return null;
    const custom = rawFields
      .map((raw) => mapFetchedCustomField(raw as RawCatalogField))
      .filter((f): f is FilterField => f !== null);
    return custom.length > 0 ? custom : null;
  } catch {
    return null;
  }
}

/**
 * Merge custom fields over the static core catalog. Core entries always win
 * a name collision (a custom key can never shadow a core field — the BE's
 * RESERVED_KEYS already forbids it; this is the FE belt to that suspender).
 */
export function mergeFilterCatalog(
  staticFields: FilterField[],
  customFields: FilterField[],
): FilterField[] {
  const coreNames = new Set(staticFields.map((f) => f.name));
  return [...staticFields, ...customFields.filter((f) => !coreNames.has(f.name))];
}
