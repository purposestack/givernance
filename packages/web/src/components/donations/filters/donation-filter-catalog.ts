/**
 * Dynamic donations filter-field catalog (flag `donations.advanced_filters`).
 *
 * The static `donationFilterFields` mirror stays the source of truth for
 * CORE donation fields (curated operators, input types, i18n labels —
 * rendering is deterministic and testable offline). The server catalog
 * (`GET /v1/donations/filter/fields`) contributes the parts only the server
 * knows:
 *
 *   1. ENTITY options (`optionsKind: "entity"`) — the org's campaign / fund
 *      id→name lists for `donation.campaign` / `donation.fund`. Tenant data,
 *      injected into the matching static field and rendered literally
 *      (`optionLabelKind: "literal"`, Epic #539 label contract).
 *   2. Per-org DONATION-domain custom fields (`custom.<key>`, `category:
 *      "custom"`, `labelKind: "literal"`, Epic #539) — appended via the
 *      generic mapping with the raw definition `uiType` translated through
 *      the shared constituents map. Donor (constituent-domain) custom
 *      fields never appear (Epic #539 §6 veto — BE-enforced).
 *   3. Future fields the static mirror doesn't know yet — mapped through
 *      generic rules and appended, so a BE-only addition degrades to a
 *      usable (if unpolished) editor instead of being invisible.
 *
 * On any fetch failure the builder degrades to the static catalog alone —
 * core filtering must never break because the enrichment is unavailable.
 */

import type { CustomFieldType } from "@givernance/shared/custom-fields";
import { UI_TYPE_BY_CUSTOM_TYPE } from "@/components/constituents/filters/filter-catalog";
import type {
  FilterField,
  FilterFieldType,
  FilterOperator,
} from "@/components/constituents/filters/filter-types";
import type { ApiClient } from "@/lib/api";

/** Namespace every donations-filter i18n key resolves under. */
export const DONATION_FILTERS_NAMESPACE = "donations.filters";

/** BE endpoints for the donations filter surfaces (mirror of `filter.routes.ts`). */
export const DONATION_FILTER_ENDPOINTS = {
  fields: "/v1/donations/filter/fields",
  preview: "/v1/donations/filter/preview",
  suggestions: "/v1/donations/filter/suggestions",
} as const;

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

/**
 * Wire shape of one `GET /v1/donations/filter/fields` entry
 * (`DonationCatalogFieldSchema` / `serializeDonationCatalogField` in
 * `packages/api/src/modules/donations/filters/filter.routes.ts`).
 */
export interface RawDonationCatalogField {
  name?: unknown;
  type?: unknown;
  operators?: unknown;
  label?: unknown;
  labelKind?: unknown;
  category?: unknown;
  nullable?: unknown;
  /** Raw DEFINITION type of a custom field ('picklist', 'currency', …). */
  uiType?: unknown;
  options?: unknown;
  optionsKind?: unknown;
  valueUnit?: unknown;
}

const DONATION_CATEGORIES = new Set(["donation", "payment", "attribution", "receipt", "custom"]);

function parseOperators(raw: unknown): FilterOperator[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (op): op is FilterOperator =>
      typeof op === "string" && VALID_OPERATORS.has(op as FilterOperator),
  );
}

interface ParsedCatalogOption {
  value: string;
  label: string;
  active: boolean;
}

function parseOptions(raw: unknown): ParsedCatalogOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (o): o is { id: string; label: string; active?: boolean } =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as { id?: unknown }).id === "string" &&
        typeof (o as { label?: unknown }).label === "string",
    )
    .map((o) => ({ value: o.id, label: o.label, active: o.active !== false }));
}

/** BE DSL value-shape → FE input widget, for fields with no option list. */
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
 * Generic mapping of one fetched entry onto a builder field — used for
 * per-org CUSTOM fields (`category: "custom"`, Epic #539 — the static
 * mirror can never know them) and for future BE additions the mirror
 * doesn't carry yet. Returns null for anything malformed, which the merge
 * simply drops.
 */
export function mapDonationCatalogField(raw: RawDonationCatalogField): FilterField | null {
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  if (typeof raw.label !== "string" || raw.label.length === 0) return null;
  if (typeof raw.category !== "string" || !DONATION_CATEGORIES.has(raw.category)) return null;
  const operators = parseOperators(raw.operators);
  if (operators.length === 0) return null;

  const isCustom = raw.category === "custom";
  const options = parseOptions(raw.options).filter((o) => o.active);
  const isEnum = raw.optionsKind === "enum";
  const isEntity = raw.optionsKind === "entity";

  // Custom entries ship the raw DEFINITION type as `uiType` ('picklist',
  // 'currency', …) — translate it through the SAME map as the constituents
  // catalog (PR #550 lesson: 'picklist' fails the FE-type check untranslated
  // and would degrade to a free-text input whose typed label can never match
  // the stored `opt_*` ids; 'multi_picklist' must become a multiselect, not
  // the options-imply-select default).
  const translatedCustomType: FilterFieldType | null =
    typeof raw.uiType === "string" && raw.uiType in UI_TYPE_BY_CUSTOM_TYPE
      ? UI_TYPE_BY_CUSTOM_TYPE[raw.uiType as CustomFieldType]
      : null;

  const uiType: FilterFieldType | null =
    translatedCustomType ?? (options.length > 0 ? "select" : uiTypeFromDslType(raw.type));
  if (!uiType) return null;

  return {
    name: raw.name,
    // i18n labels arrive in the relative `fields.<dotted-name>` form and are
    // resolved under `donations.filters`; literal labels (custom fields —
    // operator-authored tenant data) render verbatim.
    label: raw.label,
    labelKind: isCustom || raw.labelKind === "literal" ? "literal" : "i18n",
    type: uiType,
    category: raw.category as FilterField["category"],
    operators,
    ...(options.length > 0
      ? {
          options: options.map((o) => ({
            value: o.value,
            // Closed platform enums are localized by the FE
            // (`options.<field>.<id>`); entity AND custom-picklist labels
            // are tenant data, rendered literally.
            label: isEnum ? `options.${String(raw.name)}.${o.value}` : o.label,
          })),
          optionLabelKind: isEntity || isCustom ? ("literal" as const) : ("i18n" as const),
        }
      : {}),
  };
}

/**
 * Merge the fetched catalog over the static mirror:
 *  - static fields keep their curated shape; entity-optioned entries
 *    (`donation.campaign` / `donation.fund`) get the per-org option list
 *    injected (active options only, literal labels);
 *  - fetched fields unknown to the mirror are appended via the generic
 *    mapping;
 *  - `rawFields === null` (fetch failed) → static catalog unchanged.
 */
export function mergeDonationFilterCatalog(
  staticFields: FilterField[],
  rawFields: RawDonationCatalogField[] | null,
): FilterField[] {
  if (!rawFields) return staticFields;

  const rawByName = new Map<string, RawDonationCatalogField>();
  for (const raw of rawFields) {
    if (typeof raw.name === "string") rawByName.set(raw.name, raw);
  }

  const merged = staticFields.map((field) => {
    const raw = rawByName.get(field.name);
    if (raw?.optionsKind !== "entity") return field;
    const options = parseOptions(raw.options)
      .filter((o) => o.active)
      .map((o) => ({ value: o.value, label: o.label }));
    return { ...field, options, optionLabelKind: "literal" as const };
  });

  const staticNames = new Set(staticFields.map((f) => f.name));
  const appended = rawFields
    .filter((raw) => typeof raw.name === "string" && !staticNames.has(raw.name))
    .map((raw) => mapDonationCatalogField(raw))
    .filter((f): f is FilterField => f !== null);

  return [...merged, ...appended];
}

/**
 * Fetch the donations filter catalog. `null` = fetch failed / malformed —
 * callers keep the static catalog (the endpoint is also flag-gated 404-off,
 * but callers must never reach here with the flag off in the first place:
 * every donations-filter surface is hidden when it is).
 */
export async function fetchDonationFilterFields(
  client: ApiClient,
): Promise<RawDonationCatalogField[] | null> {
  try {
    const response = await client.get<{ data: { fields?: unknown } }>(
      DONATION_FILTER_ENDPOINTS.fields,
    );
    const rawFields = response.data?.fields;
    return Array.isArray(rawFields) ? (rawFields as RawDonationCatalogField[]) : null;
  } catch {
    return null;
  }
}
