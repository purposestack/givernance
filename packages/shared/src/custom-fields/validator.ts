/**
 * Custom-value validation + merge-patch semantics (Epic #539).
 *
 * Consumed identically by API services (`validateCustomPatch` in the
 * customization value-service), the bulk-import worker, `packages/migrate`,
 * and web forms (client-side UX only — the server stays authoritative).
 * Runs in browser bundles: no Node-only imports.
 *
 * Contract:
 *   - Input is a merge-patch: explicit `null` clears a key, absent keys
 *     are untouched. The stored blob never contains `null` — a cleared
 *     key is removed (absent ≡ null ≡ "is empty").
 *   - Unknown keys (including archived definitions, which are absent
 *     from the active catalog) are errors — archived values stay
 *     readable but are never writable.
 *   - Every patch entry is checked; the error list is complete, not
 *     first-failure, so the 422 response can name every bad field.
 */

import { CUSTOM_FIELD_LONG_TEXT_MAX_LENGTH, CUSTOM_FIELD_TEXT_MAX_LENGTH } from "./limits";
import type {
  CustomFieldDefinition,
  CustomFieldPatch,
  CustomFieldValue,
  CustomFieldValues,
} from "./types";

/**
 * Machine-readable error codes for the 422 matrix. Routes surface these
 * as RFC 9457 extensions; the web form maps them onto field errors.
 */
export type CustomFieldValueErrorCode =
  | "unknown_key"
  | "invalid_type"
  | "too_long"
  | "not_finite"
  | "not_integer"
  | "invalid_date"
  | "unknown_option"
  | "inactive_option"
  | "required_missing";

export interface CustomFieldValueError {
  /** Definition key the error is about (patch key for `unknown_key`). */
  key: string;
  code: CustomFieldValueErrorCode;
  /** Developer/operator-readable detail; not localized. */
  message: string;
}

export type CustomPatchResult =
  | { ok: true; merged: CustomFieldValues }
  | { ok: false; errors: CustomFieldValueError[] };

export interface ValidatePatchOptions {
  /**
   * `true` on create paths: after merging, every `required` definition
   * must hold a value. Updates leave it off — required is enforced on
   * new writes only, never retro-blocking (Epic #539 §3.1).
   */
  enforceRequired?: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

interface NormalizeOutcome {
  /** `undefined` means "clears the key" (explicit null / empty input). */
  value: CustomFieldValue | undefined;
  error: CustomFieldValueError | null;
}

function ok(value: CustomFieldValue | undefined): NormalizeOutcome {
  return { value, error: null };
}

function fail(key: string, code: CustomFieldValueErrorCode, message: string): NormalizeOutcome {
  return { value: undefined, error: { key, code, message } };
}

function normalizeText(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  const { key, type } = def;
  if (typeof raw !== "string") {
    return fail(key, "invalid_type", `'${key}' expects a string`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return ok(undefined);
  }
  const max = type === "text" ? CUSTOM_FIELD_TEXT_MAX_LENGTH : CUSTOM_FIELD_LONG_TEXT_MAX_LENGTH;
  if (trimmed.length > max) {
    return fail(key, "too_long", `'${key}' exceeds ${max} characters`);
  }
  return ok(trimmed);
}

function normalizeNumeric(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  const { key, type } = def;
  if (typeof raw !== "number") {
    const expected = type === "currency" ? "an amount in integer cents" : "a number";
    return fail(key, "invalid_type", `'${key}' expects ${expected}`);
  }
  if (!Number.isFinite(raw)) {
    return fail(key, "not_finite", `'${key}' must be a finite number`);
  }
  if (type === "currency" && !Number.isInteger(raw)) {
    return fail(key, "not_integer", `'${key}' must be integer cents`);
  }
  return ok(raw);
}

function normalizeDate(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  const { key } = def;
  if (typeof raw !== "string") {
    return fail(key, "invalid_type", `'${key}' expects a 'YYYY-MM-DD' string`);
  }
  if (!isValidCalendarDate(raw)) {
    return fail(key, "invalid_date", `'${key}' must be a valid 'YYYY-MM-DD' date`);
  }
  return ok(raw);
}

function normalizeBoolean(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  if (typeof raw !== "boolean") {
    return fail(def.key, "invalid_type", `'${def.key}' expects a boolean`);
  }
  return ok(raw);
}

function checkOption(def: CustomFieldDefinition, id: string): NormalizeOutcome | null {
  const option = def.options.find((candidate) => candidate.id === id);
  if (!option) {
    return fail(def.key, "unknown_option", `'${id}' is not an option of '${def.key}'`);
  }
  if (!option.active) {
    return fail(def.key, "inactive_option", `option '${id}' of '${def.key}' is deactivated`);
  }
  return null;
}

function normalizePicklist(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  if (typeof raw !== "string") {
    return fail(def.key, "invalid_type", `'${def.key}' expects an option id`);
  }
  return checkOption(def, raw) ?? ok(raw);
}

function normalizeMultiPicklist(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  if (!Array.isArray(raw)) {
    return fail(def.key, "invalid_type", `'${def.key}' expects an array of option ids`);
  }
  const deduped: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return fail(def.key, "invalid_type", `'${def.key}' expects an array of option ids`);
    }
    const optionError = checkOption(def, entry);
    if (optionError) {
      return optionError;
    }
    if (!deduped.includes(entry)) {
      deduped.push(entry);
    }
  }
  if (deduped.length === 0) {
    return ok(undefined);
  }
  return ok(deduped);
}

function normalizeValue(def: CustomFieldDefinition, raw: unknown): NormalizeOutcome {
  switch (def.type) {
    case "text":
    case "long_text":
      return normalizeText(def, raw);
    case "number":
    case "currency":
      return normalizeNumeric(def, raw);
    case "date":
      return normalizeDate(def, raw);
    case "boolean":
      return normalizeBoolean(def, raw);
    case "picklist":
      return normalizePicklist(def, raw);
    case "multi_picklist":
      return normalizeMultiPicklist(def, raw);
  }
}

function isEmptyValue(value: CustomFieldValue | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

/**
 * Merge-patch application WITHOUT validation — the raw JSON-merge-patch
 * semantics (RFC 7386 restricted to one level). Prefer
 * `buildCustomValidator(...).validatePatch(...)` everywhere a definition
 * catalog is available; this helper exists for trusted internal rewrites
 * (option-merge backfill, undo restore) that operate on already-valid
 * values.
 */
export function applyCustomMergePatch(
  existing: CustomFieldValues,
  patch: CustomFieldPatch,
): CustomFieldValues {
  const merged: CustomFieldValues = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value as CustomFieldValue;
    }
  }
  return merged;
}

export interface CustomValidator {
  /** Active (non-archived) definitions the validator was built from, by key. */
  readonly defsByKey: ReadonlyMap<string, CustomFieldDefinition>;
  /**
   * Validates a merge-patch against the catalog and applies it over the
   * existing blob. Keys of `existing` that have no active definition
   * (archived fields) are preserved untouched — values are retained on
   * archive, they just stop being writable.
   */
  validatePatch(
    existing: CustomFieldValues,
    patch: CustomFieldPatch,
    options?: ValidatePatchOptions,
  ): CustomPatchResult;
}

/**
 * Builds a validator over the active definition catalog of one
 * (org × domain). The catalog is per-request data — never share a built
 * validator across orgs.
 */
export function buildCustomValidator(defs: readonly CustomFieldDefinition[]): CustomValidator {
  const defsByKey = new Map<string, CustomFieldDefinition>(defs.map((def) => [def.key, def]));

  function applyEntry(
    merged: CustomFieldValues,
    errors: CustomFieldValueError[],
    key: string,
    raw: unknown,
  ): void {
    const def = defsByKey.get(key);
    if (!def) {
      errors.push({ key, code: "unknown_key", message: `'${key}' is not an active custom field` });
      return;
    }
    if (raw === null || raw === undefined) {
      delete merged[key];
      return;
    }
    const outcome = normalizeValue(def, raw);
    if (outcome.error) {
      errors.push(outcome.error);
      return;
    }
    if (outcome.value === undefined) {
      delete merged[key];
    } else {
      merged[key] = outcome.value;
    }
  }

  function validatePatch(
    existing: CustomFieldValues,
    patch: CustomFieldPatch,
    options?: ValidatePatchOptions,
  ): CustomPatchResult {
    const errors: CustomFieldValueError[] = [];
    const merged: CustomFieldValues = { ...existing };

    for (const [key, raw] of Object.entries(patch)) {
      applyEntry(merged, errors, key, raw);
    }

    if (options?.enforceRequired) {
      for (const def of defsByKey.values()) {
        if (def.required && isEmptyValue(merged[def.key])) {
          errors.push({
            key: def.key,
            code: "required_missing",
            message: `'${def.key}' is required`,
          });
        }
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, merged };
  }

  return { defsByKey, validatePatch };
}
