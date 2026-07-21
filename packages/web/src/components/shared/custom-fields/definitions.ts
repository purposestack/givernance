/**
 * Custom-field catalog access + value helpers (Epic #539).
 *
 * Server- and client-safe (no React, no "use client"): pages SSR-fetch the
 * per-domain definition catalog here and thread it down as serialisable
 * props; forms use the patch builder at submit time.
 *
 * ADR-013: only the web-safe `@givernance/shared/custom-fields` subpath is
 * imported — never `/schema`.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type {
  CustomFieldDefinition,
  CustomFieldDomain,
  CustomFieldOption,
  CustomFieldValue,
  CustomFieldValues,
} from "@givernance/shared/custom-fields";
import type { ApiClient } from "@/lib/api";

/** Feature-flag key guarding each custom-field domain (per-domain kill switch). */
export const CUSTOM_FIELD_FLAG_BY_DOMAIN: Record<CustomFieldDomain, string> = {
  constituent: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
  donation: FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
  campaign: FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
};

interface RawOption {
  id?: unknown;
  label?: unknown;
  active?: unknown;
  sortOrder?: unknown;
  mergedInto?: unknown;
}

interface RawDefinition {
  id?: unknown;
  domain?: unknown;
  key?: unknown;
  label?: unknown;
  description?: unknown;
  type?: unknown;
  options?: unknown;
  sortOrder?: unknown;
  required?: unknown;
  filterable?: unknown;
  exportable?: unknown;
  showOnRelated?: unknown;
  sensitive?: unknown;
  purposeText?: unknown;
  archivedAt?: unknown;
}

/**
 * A definition as rendered on DETAIL pages: archived definitions ride along
 * (`archivedAt` set) so values already entered stay visible, per the
 * operator-facing archive contract ("values stay visible on detail pages
 * and in exports"). Forms / filters / columns keep using the active-only
 * `CustomFieldDefinition` catalog.
 */
export interface DetailCustomFieldDefinition extends CustomFieldDefinition {
  /** ISO timestamp when the definition was archived — `null` when active. */
  archivedAt: string | null;
}

function mapOption(raw: RawOption): CustomFieldOption | null {
  if (typeof raw.id !== "string" || typeof raw.label !== "string") return null;
  return {
    id: raw.id,
    label: raw.label,
    active: raw.active !== false,
    sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : 0,
    ...(typeof raw.mergedInto === "string" ? { mergedInto: raw.mergedInto } : {}),
  };
}

/**
 * Explicit field-by-field copy (drops unknown props — same posture as the
 * domain service `map*` helpers). Malformed entries are dropped rather than
 * crashing a page over one bad catalog row.
 */
function mapDefinition(raw: RawDefinition): CustomFieldDefinition | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.key !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.domain !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    domain: raw.domain as CustomFieldDomain,
    key: raw.key,
    label: raw.label,
    description: typeof raw.description === "string" ? raw.description : null,
    type: raw.type as CustomFieldDefinition["type"],
    options: Array.isArray(raw.options)
      ? (raw.options as RawOption[])
          .map(mapOption)
          .filter((o): o is CustomFieldOption => o !== null)
      : [],
    sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : 0,
    required: raw.required === true,
    filterable: raw.filterable === true,
    exportable: raw.exportable !== false,
    showOnRelated: raw.showOnRelated === true,
    sensitive: raw.sensitive === true,
    purposeText: typeof raw.purposeText === "string" ? raw.purposeText : null,
  };
}

/** Unwrap the `{data: [...]}` / `{data: {definitions: [...]}}` envelope variants. */
function unwrapDefinitionList(payload: unknown): RawDefinition[] {
  const list = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { definitions?: unknown }).definitions)
      ? (payload as { definitions: unknown[] }).definitions
      : [];
  return list as RawDefinition[];
}

/**
 * Fetch the active (non-archived) definitions for one domain from
 * `GET /v1/custom-fields?domain=`. Accepts either `{data: [...]}` or
 * `{data: {definitions: [...]}}` payload shapes so the page wiring is not
 * coupled to the exact envelope while the customization module stabilises.
 */
export async function fetchCustomFieldDefinitions(
  client: ApiClient,
  domain: CustomFieldDomain,
): Promise<CustomFieldDefinition[]> {
  const response = await client.get<{ data: unknown }>("/v1/custom-fields", {
    params: { domain },
  });
  return unwrapDefinitionList(response.data)
    .map(mapDefinition)
    .filter((d): d is CustomFieldDefinition => d !== null && d.domain === domain)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Detail-page catalog for one domain: `GET /v1/custom-fields?domain=&includeArchived=true`.
 * Active definitions come first (sortOrder-ordered) followed by archived ones
 * (sortOrder-ordered), matching the API's detail serializers which emit
 * archived keys too. Never used for forms, filters or columns — those stay
 * on the active-only catalog.
 */
export async function fetchDetailCustomFieldDefinitions(
  client: ApiClient,
  domain: CustomFieldDomain,
): Promise<DetailCustomFieldDefinition[]> {
  const response = await client.get<{ data: unknown }>("/v1/custom-fields", {
    params: { domain, includeArchived: true },
  });
  const mapped = unwrapDefinitionList(response.data)
    .map((raw): DetailCustomFieldDefinition | null => {
      const definition = mapDefinition(raw);
      if (definition === null) return null;
      return {
        ...definition,
        archivedAt:
          typeof raw.archivedAt === "string" && raw.archivedAt !== "" ? raw.archivedAt : null,
      };
    })
    .filter((d): d is DetailCustomFieldDefinition => d !== null && d.domain === domain);
  const active = mapped.filter((d) => d.archivedAt === null);
  const archived = mapped.filter((d) => d.archivedAt !== null);
  active.sort((a, b) => a.sortOrder - b.sortOrder);
  archived.sort((a, b) => a.sortOrder - b.sortOrder);
  return [...active, ...archived];
}

/**
 * Page-level helper: definitions for a domain, or `[]` when the domain flag
 * is off (route 404s) or the catalog fetch fails. A catalog failure must
 * never break the page — every custom surface simply stays absent.
 */
export async function fetchCustomFieldDefinitionsOrEmpty(
  client: ApiClient,
  domain: CustomFieldDomain,
  enabled: boolean,
): Promise<CustomFieldDefinition[]> {
  if (!enabled) return [];
  try {
    return await fetchCustomFieldDefinitions(client, domain);
  } catch {
    return [];
  }
}

/**
 * Detail-page variant of {@link fetchCustomFieldDefinitionsOrEmpty}: archived
 * definitions ride along so their stored values keep rendering (read-only,
 * "archived"-badged) on the three domain detail pages.
 */
export async function fetchDetailCustomFieldDefinitionsOrEmpty(
  client: ApiClient,
  domain: CustomFieldDomain,
  enabled: boolean,
): Promise<DetailCustomFieldDefinition[]> {
  if (!enabled) return [];
  try {
    return await fetchDetailCustomFieldDefinitions(client, domain);
  } catch {
    return [];
  }
}

/**
 * Which detail-page rows actually render: every active definition (empty
 * values show an em-dash), but archived definitions only when this record
 * still holds a value — an archived field with nothing entered adds no row.
 *
 * Archive-and-recreate dedupe: when a key was archived and then recreated
 * (the documented type-change flow), the catalog carries BOTH definitions
 * for the same key. Both would read `values[key]`, rendering the same
 * stored value twice — once through the STALE archived definition's
 * type/options. The active definition wins and the archived twin is
 * dropped, mirroring the server-side serializer contract ("active
 * definition wins — the value serializes once").
 */
export function visibleDetailCustomFieldDefinitions<
  T extends CustomFieldDefinition & { archivedAt?: string | null },
>(defs: readonly T[], values: CustomFieldValues | null | undefined): T[] {
  const activeKeys = new Set(defs.filter((d) => !d.archivedAt).map((d) => d.key));
  return defs.filter((d) => {
    if (!d.archivedAt) return true;
    if (activeKeys.has(d.key)) return false;
    return !isEmptyCustomValue(values?.[d.key]);
  });
}

/**
 * Constituent definitions eligible for cross-domain projection
 * (`donorCustom`). Mirrors the server rule (`showOnRelated ∧ ¬sensitive`);
 * the API re-enforces eligibility per request — this filter only decides
 * which columns/rows the UI renders, never what data is exposed.
 */
export function projectableDefinitions(defs: CustomFieldDefinition[]): CustomFieldDefinition[] {
  return defs.filter((d) => d.showOnRelated && !d.sensitive);
}

/** Resolve a picklist option's operator-authored label (falls back to the raw id). */
export function customOptionLabel(definition: CustomFieldDefinition, optionId: string): string {
  return definition.options.find((o) => o.id === optionId)?.label ?? optionId;
}

/** True when the value counts as "empty" (absent key ≡ null ≡ empty). */
export function isEmptyCustomValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Read the initial editable values for a form from a stored blob: only keys
 * with an active definition are surfaced (archived/unknown keys stay
 * untouched in the blob — the API preserves them on merge-patch).
 */
export function initialCustomValues(
  defs: CustomFieldDefinition[],
  stored: CustomFieldValues | undefined,
): Record<string, CustomFieldValue> {
  const values: Record<string, CustomFieldValue> = {};
  if (!stored) return values;
  for (const def of defs) {
    const value = stored[def.key];
    if (value !== undefined) values[def.key] = value;
  }
  return values;
}

/**
 * Build the merge-patch to submit: absent keys are untouched server-side, so
 * only keys the operator can edit (active defs) are included. A key that had
 * a stored value and is now empty is sent as an explicit `null` clear;
 * empty-and-was-empty keys are omitted entirely.
 */
export function buildCustomFieldPatch(
  initial: Record<string, CustomFieldValue>,
  current: Record<string, CustomFieldValue>,
  defs: CustomFieldDefinition[],
): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  for (const def of defs) {
    const next = current[def.key];
    const empty = isEmptyCustomValue(next);
    if (empty) {
      if (initial[def.key] !== undefined) patch[def.key] = null;
      continue;
    }
    patch[def.key] = next;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Required-on-new-writes client check (UX only — the server is
 * authoritative). Returns the keys of required definitions with no value.
 */
export function missingRequiredCustomKeys(
  defs: CustomFieldDefinition[],
  values: Record<string, CustomFieldValue>,
): string[] {
  return defs.filter((d) => d.required && isEmptyCustomValue(values[d.key])).map((d) => d.key);
}

/**
 * Explicit copy of a `custom` blob from an API response: only plain
 * string/number/boolean/string[] values survive (the same shapes the shared
 * validator persists). Used by the domain services' `map*` helpers, whose
 * field-by-field copies would otherwise drop the blob entirely.
 */
export function sanitizeCustomValues(raw: unknown): CustomFieldValues | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const values: Record<string, CustomFieldValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values[key] = value;
    } else if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * Map a 422's `fieldErrors` extension onto per-key custom-field messages.
 * Tolerates the shapes the API may emit while the customization module
 * stabilises: `{ "custom.key": msg }`, `{ custom: { key: msg | [msg] } }`,
 * and `{ custom: [{ key, message }] }`.
 */
export function extractCustomFieldErrors(fieldErrors: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fieldErrors || typeof fieldErrors !== "object") return out;
  const record = fieldErrors as Record<string, unknown>;

  collectDottedErrors(record, out);
  collectNestedErrors(record.custom, out);
  return out;
}

function collectDottedErrors(record: Record<string, unknown>, out: Record<string, string>): void {
  for (const [name, value] of Object.entries(record)) {
    if (!name.startsWith("custom.")) continue;
    const message = firstMessage(value);
    if (message) out[name.slice("custom.".length)] = message;
  }
}

function collectNestedErrors(custom: unknown, out: Record<string, string>): void {
  if (Array.isArray(custom)) {
    for (const entry of custom) {
      if (!entry || typeof entry !== "object") continue;
      const { key, message } = entry as { key?: unknown; message?: unknown };
      if (typeof key === "string" && typeof message === "string") out[key] = message;
    }
    return;
  }
  if (custom && typeof custom === "object") {
    for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
      const message = firstMessage(value);
      if (message) out[key] = message;
    }
  }
}

function firstMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}
