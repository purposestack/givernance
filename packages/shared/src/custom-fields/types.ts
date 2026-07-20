/**
 * Custom-field engine — shared domain types (Epic #539).
 *
 * This directory is imported by the API, the worker, `packages/migrate`,
 * AND the web forms (client-side UX validation). It must therefore stay
 * free of Drizzle / Node-only imports — the schema layer
 * (`schema/customization.ts`) imports FROM here, never the reverse.
 */

/**
 * Domains a definition can attach to. Closed set — `grant` is added
 * additively when the grants domain ships; there are no custom
 * objects / collections in any form (Epic #539 anti-goal #1).
 */
export const CUSTOM_FIELD_DOMAIN_VALUES = ["constituent", "donation", "campaign"] as const;
export type CustomFieldDomain = (typeof CUSTOM_FIELD_DOMAIN_VALUES)[number];

/**
 * Closed set of value types. Immutable per definition — a type change is
 * archive + recreate. Deliberately excludes formula / roll-up / lookup /
 * file / user-reference types (refused Salesforce traps, Epic #539 §13).
 */
export const CUSTOM_FIELD_TYPE_VALUES = [
  "text",
  "long_text",
  "number",
  "date",
  "boolean",
  "picklist",
  "multi_picklist",
  "currency",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPE_VALUES)[number];

/**
 * Definition key shape: lowercase snake, 2–63 chars, immutable after
 * creation. Mirrored by the DB CHECK constraint in migration 0086.
 */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * Picklist option ids: `opt_` + 8 url-safe random chars. Values store
 * these ids, never labels — rename-in-place is free; merge is the only
 * operation that rewrites stored values.
 */
export const CUSTOM_FIELD_OPTION_ID_PATTERN = /^opt_[A-Za-z0-9_-]{8}$/;

const OPTION_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * Generates a fresh option id. Uses the WebCrypto global so the same
 * code path runs in Node 22 and in the browser (web form previews).
 */
export function generateOptionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) {
    suffix += OPTION_ID_ALPHABET[byte % OPTION_ID_ALPHABET.length];
  }
  return `opt_${suffix}`;
}

/** One picklist / multi-picklist option embedded in the definition row. */
export interface CustomFieldOption {
  id: string;
  /** Operator-authored — rendered literally, never an i18n key. */
  label: string;
  /**
   * `false` hides the option from forms/filters for NEW writes; stored
   * values keep rendering their label. Deactivation never rewrites data.
   */
  active: boolean;
  sortOrder: number;
  /**
   * Set when this option was merged away: points at the surviving
   * option id. Merged options are also `active: false`.
   */
  mergedInto?: string;
  /**
   * The merge that consumed this option — the handle the undo route
   * validates against. Cleared (with `mergedInto` / `mergedAt`) when the
   * merge is undone.
   */
  mergeId?: string;
  /**
   * ISO timestamp of the merge — bounds the undo window even when the
   * purge cron already deleted the undo rows (or the merge touched zero
   * rows and never had any).
   */
  mergedAt?: string;
}

/**
 * Serializable definition shape shared across API services, worker
 * processors, migrate, and web. This is the Redis-cached catalog entry —
 * a projection of the `custom_field_definitions` row (no org_id, no
 * timestamps; archived definitions never appear in the active catalog).
 */
export interface CustomFieldDefinition {
  id: string;
  domain: CustomFieldDomain;
  key: string;
  label: string;
  description: string | null;
  type: CustomFieldType;
  /** Empty for non-picklist types. */
  options: CustomFieldOption[];
  sortOrder: number;
  /** Enforced on new writes only — never retro-blocking on existing rows. */
  required: boolean;
  filterable: boolean;
  exportable: boolean;
  /** Cross-domain projection opt-in; constituent domain only, never sensitive. */
  showOnRelated: boolean;
  /** GDPR Art. 9 marker — excluded from projection and from AI context. */
  sensitive: boolean;
  /** Mandatory when `sensitive` (Art. 30 record support). */
  purposeText: string | null;
}

/**
 * A single stored custom value. `null` never persists in the blob —
 * clearing a key removes it (absent key ≡ null ≡ "is empty").
 * `string[]` is multi_picklist; `number` is `number` or `currency`
 * (integer cents); dates are `'YYYY-MM-DD'` strings.
 */
export type CustomFieldValue = string | number | boolean | string[];

/** The stored `custom` JSONB blob: definition key → value. */
export type CustomFieldValues = Record<string, CustomFieldValue>;

/**
 * A merge-patch payload as accepted on create/update routes: explicit
 * `null` clears a key, absent keys are untouched.
 */
export type CustomFieldPatch = Record<string, unknown>;
