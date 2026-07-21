/**
 * Bulk-import bridge for custom fields (Epic #539, docs/28).
 *
 * Shared by the API template generator AND the worker's import
 * validation so the `cf_<key>` header aliasing and cell-to-value
 * coercion can never drift between the two sides (the parser itself is
 * still duplicated api/worker — this module is the single home for the
 * custom-field share of it). Browser-safe: no Node-only imports.
 *
 * Contract:
 *   - A custom column is addressed by its stable `cf_<key>` alias or by
 *     the definition label (case-insensitive, whitespace-collapsed).
 *     Core headers always win — resolution here is only consulted for
 *     headers the canonical map didn't claim.
 *   - Cells are coerced from CSV strings to typed values, then the
 *     result MUST still go through `buildCustomValidator` — coercion is
 *     lossy convenience (labels → option ids, decimals → cents), the
 *     validator stays authoritative.
 *   - Picklist cells match option labels (or raw option ids)
 *     case-insensitively against ACTIVE options only; an unknown value
 *     is a per-row error, never an auto-created option.
 */

import { CUSTOM_FIELDS_IMPORT_HEADER_PREFIX } from "./constants";
import type { CustomFieldDefinition, CustomFieldOption, CustomFieldValue } from "./types";

/** `cf_<key>` — the machine-stable import header for a definition. */
export function customImportAlias(key: string): string {
  return `${CUSTOM_FIELDS_IMPORT_HEADER_PREFIX}${key}`;
}

/** Lowercase + collapse whitespace — same normalisation the import parsers apply. */
export function normaliseImportHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export type CustomHeaderResolver = (raw: string) => CustomFieldDefinition | null;

/**
 * Builds the header → definition resolver for one org's active
 * constituent catalog. `cf_<key>` matches first (stable across label
 * renames), then the label. Labels that collide with each other resolve
 * to the first definition in catalog (sort) order — the template
 * generator avoids emitting ambiguous label headers via
 * `customTemplateHeader`.
 */
export function buildCustomHeaderResolver(
  defs: readonly CustomFieldDefinition[],
): CustomHeaderResolver {
  const byAlias = new Map<string, CustomFieldDefinition>();
  const byLabel = new Map<string, CustomFieldDefinition>();
  for (const def of defs) {
    byAlias.set(normaliseImportHeader(customImportAlias(def.key)), def);
    const label = normaliseImportHeader(def.label);
    if (label && !byLabel.has(label)) {
      byLabel.set(label, def);
    }
  }
  return (raw: string) => {
    const cleaned = normaliseImportHeader(raw);
    if (!cleaned) return null;
    return byAlias.get(cleaned) ?? byLabel.get(cleaned) ?? null;
  };
}

/**
 * Header cell the import template emits for a definition: the label
 * (operator-readable), falling back to the `cf_<key>` alias whenever the
 * label would be claimed by the core header map or by another
 * definition's label (both would misroute the column on re-import).
 * `isCoreHeader` is injected by the caller — the canonical alias map
 * lives with the parsers, not here.
 */
export function customTemplateHeader(
  def: CustomFieldDefinition,
  allDefs: readonly CustomFieldDefinition[],
  isCoreHeader: (raw: string) => boolean,
): string {
  const label = normaliseImportHeader(def.label);
  if (!label || isCoreHeader(def.label)) {
    return customImportAlias(def.key);
  }
  // A `cf_…` label would collide with the alias namespace — the resolver
  // checks aliases FIRST, so a label like 'cf_segment' would silently
  // misroute the column into the definition whose key is 'segment'. The
  // API rejects such labels at create/update; this guard covers legacy
  // rows and non-API writers.
  if (label.startsWith(CUSTOM_FIELDS_IMPORT_HEADER_PREFIX)) {
    return customImportAlias(def.key);
  }
  const labelOwner = allDefs.find((other) => normaliseImportHeader(other.label) === label);
  if (labelOwner && labelOwner.key !== def.key) {
    return customImportAlias(def.key);
  }
  return def.label;
}

/**
 * Definition keys claimed by MORE THAN ONE column of the same file —
 * i.e. the label header AND the `cf_<key>` alias both present, or the
 * same custom header simply repeated (review m12). Letting both through
 * would make the winner "last non-empty cell" — silently
 * nondeterministic — so callers MUST reject the whole file with a
 * per-file error naming these keys. Operates on RESOLVED header keys
 * (the parser's post-`resolveHeader` array): core columns are out of
 * scope by construction (only `cf_`-prefixed keys are inspected), and
 * `null` (dropped) columns are ignored.
 */
export function findDuplicateCustomHeaderKeys(
  resolvedHeaderKeys: readonly (string | null)[],
): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const key of resolvedHeaderKeys) {
    if (!key || !key.startsWith(CUSTOM_FIELDS_IMPORT_HEADER_PREFIX)) continue;
    if (seen.has(key)) duplicated.add(key.slice(CUSTOM_FIELDS_IMPORT_HEADER_PREFIX.length));
    seen.add(key);
  }
  return [...duplicated];
}

/** Stable per-row error codes surfaced in `bulk_import_results.error_code`. */
export type CustomImportCellErrorCode =
  | "INVALID_CUSTOM_NUMBER"
  | "INVALID_CUSTOM_AMOUNT"
  | "INVALID_CUSTOM_BOOLEAN"
  | "UNKNOWN_CUSTOM_OPTION";

export interface CustomImportCellError {
  /** The `cf_<key>` alias of the offending column. */
  field: string;
  code: CustomImportCellErrorCode;
  /** Never echoes the rejected cell content (import-validation GDPR posture). */
  message: string;
}

export type CustomImportCellResult =
  | { ok: true; value: CustomFieldValue }
  | { ok: false; error: CustomImportCellError };

const TRUE_TOKENS = new Set(["true", "yes", "oui", "ja", "1", "x"]);
const FALSE_TOKENS = new Set(["false", "no", "non", "nein", "0"]);

/** Decimal with optional `.`/`,` separator, spaces / `'` thousand marks stripped. */
const AMOUNT_PATTERN = /^-?\d+(?:[.,]\d{1,2})?$/;

function cellError(
  def: CustomFieldDefinition,
  code: CustomImportCellErrorCode,
  message: string,
): CustomImportCellResult {
  return { ok: false, error: { field: customImportAlias(def.key), code, message } };
}

function parseNumberCell(def: CustomFieldDefinition, raw: string): CustomImportCellResult {
  const value = Number(raw.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(value)) {
    return cellError(def, "INVALID_CUSTOM_NUMBER", `'${def.key}' expects a number`);
  }
  return { ok: true, value };
}

function parseAmountCell(def: CustomFieldDefinition, raw: string): CustomImportCellResult {
  const cleaned = raw.replace(/[\s']/g, "");
  if (!AMOUNT_PATTERN.test(cleaned)) {
    return cellError(
      def,
      "INVALID_CUSTOM_AMOUNT",
      `'${def.key}' expects an amount like 25 or 25.50 (max two decimals)`,
    );
  }
  const major = Number(cleaned.replace(",", "."));
  return { ok: true, value: Math.round(major * 100) };
}

function parseBooleanCell(def: CustomFieldDefinition, raw: string): CustomImportCellResult {
  const token = raw.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) return { ok: true, value: true };
  if (FALSE_TOKENS.has(token)) return { ok: true, value: false };
  return cellError(
    def,
    "INVALID_CUSTOM_BOOLEAN",
    `'${def.key}' expects yes/no (oui/non, true/false)`,
  );
}

/**
 * Case-insensitive option lookup over ACTIVE options: by label first,
 * then by raw option id (so a re-imported export round-trips). Merged /
 * deactivated options never match — the validator's `inactive_option`
 * path is for API payloads that address them by id directly.
 */
function resolveOption(def: CustomFieldDefinition, raw: string): CustomFieldOption | null {
  const token = normaliseImportHeader(raw);
  if (!token) return null;
  const active = def.options.filter((option) => option.active);
  return (
    active.find((option) => normaliseImportHeader(option.label) === token) ??
    active.find((option) => option.id.toLowerCase() === token) ??
    null
  );
}

function parsePicklistCell(def: CustomFieldDefinition, raw: string): CustomImportCellResult {
  const option = resolveOption(def, raw);
  if (!option) {
    return cellError(
      def,
      "UNKNOWN_CUSTOM_OPTION",
      `'${def.key}' has no active option matching the provided value`,
    );
  }
  return { ok: true, value: option.id };
}

function parseMultiPicklistCell(def: CustomFieldDefinition, raw: string): CustomImportCellResult {
  // `;` / `|` separators only — option labels legitimately contain commas.
  const parts = raw
    .split(/[;|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const ids: string[] = [];
  for (const part of parts) {
    const option = resolveOption(def, part);
    if (!option) {
      return cellError(
        def,
        "UNKNOWN_CUSTOM_OPTION",
        `'${def.key}' has no active option matching one of the provided values`,
      );
    }
    if (!ids.includes(option.id)) ids.push(option.id);
  }
  return { ok: true, value: ids };
}

/**
 * Coerce one non-empty CSV cell string into the typed value shape the
 * validator expects. Text / date cells pass through untouched — the
 * validator owns length caps and calendar-date checks.
 */
export function parseCustomImportCell(
  def: CustomFieldDefinition,
  raw: string,
): CustomImportCellResult {
  switch (def.type) {
    case "text":
    case "long_text":
    case "date":
      return { ok: true, value: raw };
    case "number":
      return parseNumberCell(def, raw);
    case "currency":
      return parseAmountCell(def, raw);
    case "boolean":
      return parseBooleanCell(def, raw);
    case "picklist":
      return parsePicklistCell(def, raw);
    case "multi_picklist":
      return parseMultiPicklistCell(def, raw);
  }
}

export interface CustomImportRowOutcome {
  /** Coerced patch keyed by definition key — feed to `buildCustomValidator`. */
  patch: Record<string, CustomFieldValue>;
  errors: CustomImportCellError[];
}

/**
 * Extract + coerce every `cf_<key>` cell of a parsed row. `values` is
 * the parser's per-row map (custom cells stored under their alias);
 * absent / empty cells are simply not in the map, so an untouched
 * column never fails a row.
 */
export function buildCustomPatchFromRow(
  values: Record<string, string>,
  defs: readonly CustomFieldDefinition[],
): CustomImportRowOutcome {
  const patch: Record<string, CustomFieldValue> = {};
  const errors: CustomImportCellError[] = [];
  for (const def of defs) {
    const raw = values[customImportAlias(def.key)];
    if (raw === undefined || raw.trim() === "") continue;
    const result = parseCustomImportCell(def, raw);
    if (result.ok) {
      patch[def.key] = result.value;
    } else {
      errors.push(result.error);
    }
  }
  return { patch, errors };
}

/**
 * Example cell for the template's first sample row — enough for the
 * operator to infer the expected format without documentation. Empty
 * for free-text types (no useful canonical example).
 */
export function customTemplateSampleValue(def: CustomFieldDefinition): string {
  switch (def.type) {
    case "text":
    case "long_text":
      return "";
    case "number":
      return "42";
    case "currency":
      return "25.50";
    case "date":
      return "2026-03-15";
    case "boolean":
      return "yes";
    case "picklist":
      return def.options.find((option) => option.active)?.label ?? "";
    case "multi_picklist": {
      const labels = def.options
        .filter((option) => option.active)
        .slice(0, 2)
        .map((option) => option.label);
      return labels.join("; ");
    }
  }
}
