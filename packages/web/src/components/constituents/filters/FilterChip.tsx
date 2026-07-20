// @ts-nocheck
"use client";

import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { filterFields, getOperatorLabel } from "./filter-presets";
import type { FilterChipData, FilterField } from "./filter-types";

interface FilterChipProps {
  filter: FilterChipData;
  onRemove?: (id: string) => void;
  /**
   * Field catalog used to resolve option-value labels (Epic #539): pass the
   * merged core+custom catalog so custom picklist values render their
   * operator-authored labels instead of raw `opt_…` ids. Defaults to the
   * static core catalog.
   */
  fields?: FilterField[];
}

/**
 * next-intl statically validates message keys at compile-time; chip
 * `label` values are dynamic i18n keys (from `filterFields` or built by
 * `chipsFromQuery`) that can't be narrowed to the strict
 * `NamespacedMessageKeys` union. Cast once at the call site.
 *
 * Resilience: a chip `label` can be EITHER a registered i18n key (e.g.
 * `fields.donations.recurring` for a hand-built condition) OR an
 * already-resolved literal — `campaign-members-card` resolves pattern
 * labels (`patterns.recurring` → "Donateurs récurrents") before building
 * the chip, so the literal arrives here a second time. We therefore probe
 * `t.has(key)` first and only translate registered keys; anything else is
 * rendered verbatim.
 *
 * Why not just translate and inspect the result: next-intl 4.x reports a
 * missing message via `onError` (which surfaces a `MISSING_MESSAGE` console
 * error / dev overlay) rather than silently returning the `<namespace>.<key>`
 * path the way older versions did. The previous "translate then detect the
 * key-path" approach therefore spammed the console with one error per
 * pattern chip. `t.has` is the supported existence check; the surrounding
 * try/catch is belt-and-suspenders for any other resolution throw.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamicWithFallback(t: StrictTranslator, key: string): string {
  try {
    const has = (t as unknown as { has?: (k: string) => boolean }).has;
    // Unknown key (or a pre-resolved literal label) → render it verbatim.
    if (typeof has === "function" && !has(key)) return key;
    const resolved = (t as unknown as (k: string) => string)(key);
    // Defensive: if a version still returns the namespaced path, unwrap it.
    if (resolved === `constituents.filters.${key}` || resolved === key) return key;
    return resolved;
  } catch {
    // A missing/​unresolvable message in next-intl 4.x throws here — fall
    // back to the literal so the chip stays readable instead of crashing.
    return key;
  }
}

/**
 * Resolve a single filter value token to a display string, preferring the
 * field's catalogued i18n option label (issue #465 — so `constituent.type`
 * values like `donor`/`beneficiary` render as "Donateur"/"Bénéficiaire", not
 * the raw English enum). Order: option-shape object → translated option label
 * for this field → capitalised lowercase enum token → primitive.
 */
export function resolveValueToken(
  field: string,
  v: unknown,
  translate: (key: string) => string,
  catalog: FilterField[] = filterFields,
): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.value === "string") return obj.value;
    return String(v);
  }
  if (typeof v === "string") {
    const meta = catalog.find((f) => f.name === field);
    const optionLabel = meta?.options?.find((o) => o.value === v)?.label;
    if (optionLabel) {
      // Custom-field option labels are operator data — literal by contract
      // (Epic #539), never routed through the translator.
      if (meta?.labelKind === "literal") return optionLabel;
      const resolved = translate(optionLabel);
      // `translate` falls back to the key itself for unknown messages — only
      // use it when it actually resolved to something other than the key.
      if (resolved && resolved !== optionLabel) return resolved;
    }
    if (v.length > 0 && v === v.toLowerCase()) {
      return v.charAt(0).toUpperCase() + v.slice(1);
    }
  }
  return String(v);
}

/**
 * Format an array value (e.g. `["donor", "volunteer"]` from an `in` operator,
 * or `[{value, label}]` from a multiselect) into a human-readable string via
 * `resolveValueToken`. The chip already has `max-w-full truncate`, so long
 * joined strings are clipped with an ellipsis (full text in the title tooltip).
 */
function formatArrayValue(
  field: string,
  value: unknown[],
  translate: (key: string) => string,
  catalog: FilterField[] = filterFields,
): string {
  return value.map((v) => resolveValueToken(field, v, translate, catalog)).join(", ");
}

/**
 * Visual representation of an active filter — either a hand-built condition
 * (field + operator + value) or a BE pattern flag from a quick template.
 *
 * Pattern chips carry a sparkle icon and a soft primary tint so operators can
 * tell at a glance "this came from a quick template, not a hand-built
 * condition". Conditions render unchanged.
 */
export function FilterChip({ filter, onRemove, fields }: FilterChipProps) {
  const t = useTranslations("constituents.filters");
  const catalog = fields ?? filterFields;
  const isPattern = filter.kind === "pattern";
  // `filter.label` and `filter.field` are both candidates: callers either
  // store an i18n key (the new contract from `filter-presets.ts` /
  // `chipsFromQuery`) or a literal (legacy tests, hand-built chips). The
  // fallback helper resolves keys when known and otherwise passes the raw
  // string through.
  const rawLabel = filter.label || filter.field;
  const displayLabel = trDynamicWithFallback(t, rawLabel);

  if (isPattern) {
    return (
      <Badge
        variant="neutral"
        className="inline-flex max-w-full items-center gap-1.5 border border-primary/30 bg-primary-container/40 px-3 py-1 text-sm font-normal"
      >
        <Sparkles size={12} aria-hidden="true" className="shrink-0 text-primary" />
        <span className="min-w-0 truncate font-medium" title={displayLabel}>
          {displayLabel}
        </span>
        {filter.removable !== false && onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-1 -mr-1.5 h-4 w-4 shrink-0 p-0 hover:bg-surface-container-high"
            onClick={() => onRemove(filter.id)}
            aria-label={t("removeFilter", { label: displayLabel })}
          >
            <X size={12} aria-hidden="true" />
          </Button>
        )}
      </Badge>
    );
  }

  const translateToken = (key: string) => trDynamicWithFallback(t, key);

  const formatValue = (value: unknown): string => {
    if (Array.isArray(value)) {
      if (value.length === 2 && filter.operator === "between") {
        // Format date range
        if (typeof value[0] === "string" && value[0].match(/\d{4}-\d{2}-\d{2}/)) {
          return `${new Date(value[0]).toLocaleDateString()} - ${new Date(value[1]).toLocaleDateString()}`;
        }
        return `${value[0]} - ${value[1]}`;
      }
      return formatArrayValue(filter.field, value, translateToken, catalog);
    }

    if (typeof value === "boolean") {
      return value ? t("yes") : t("no");
    }

    if (typeof value === "string" && value.match(/\d{4}-\d{2}-\d{2}/)) {
      return new Date(value).toLocaleDateString();
    }

    // Single-value condition (e.g. legacy `eq donor`) — resolve through the
    // field's option labels too, so the type reads localised.
    return resolveValueToken(filter.field, value, translateToken, catalog);
  };

  const operatorLabel = trDynamicWithFallback(t, getOperatorLabel(filter.operator));
  const valueLabel = formatValue(filter.value);

  return (
    <Badge
      variant="neutral"
      className="inline-flex max-w-full items-center gap-1.5 px-3 py-1 text-sm font-normal"
    >
      <span className="shrink-0 font-medium">{displayLabel}</span>
      <span className="shrink-0 text-on-surface-variant">{operatorLabel}</span>
      <span className="min-w-0 truncate font-medium" title={valueLabel}>
        {valueLabel}
      </span>
      {filter.removable !== false && onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-1 -mr-1.5 h-4 w-4 shrink-0 p-0 hover:bg-surface-container-high"
          onClick={() => onRemove(filter.id)}
          aria-label={t("removeFilter", { label: displayLabel })}
        >
          <X size={12} aria-hidden="true" />
        </Button>
      )}
    </Badge>
  );
}
