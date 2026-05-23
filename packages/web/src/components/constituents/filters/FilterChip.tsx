// @ts-nocheck
"use client";

import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getOperatorLabel } from "./filter-presets";
import type { FilterChipData } from "./filter-types";

interface FilterChipProps {
  filter: FilterChipData;
  onRemove?: (id: string) => void;
}

/**
 * next-intl statically validates message keys at compile-time; chip
 * `label` values are dynamic i18n keys (from `filterFields` or built by
 * `chipsFromQuery`) that can't be narrowed to the strict
 * `NamespacedMessageKeys` union. Cast once at the call site.
 *
 * Resilience: if `label` is a literal string that isn't a registered
 * translation key (e.g. legacy test fixtures, hand-built chips), next-intl
 * returns the key path unchanged — we detect that case by checking whether
 * the resolved value still starts with `constituents.filters.` and fall
 * back to the original literal so the chip stays readable.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamicWithFallback(t: StrictTranslator, key: string): string {
  const resolved = (t as unknown as (k: string) => string)(key);
  // next-intl returns `<namespace>.<key>` when the key is unknown; detect
  // and unwrap to the original literal so e.g. `label: "City"` keeps
  // rendering as "City" rather than "constituents.filters.City".
  if (resolved === `constituents.filters.${key}` || resolved === key) {
    return key;
  }
  return resolved;
}

/**
 * Format an array value (e.g. `["donor", "volunteer"]` from an `in` operator,
 * or `[{value, label}]` from a multiselect) into a human-readable string.
 * Avoids leaking `[object Object]` when the runtime hands us an option-shape
 * array — we prefer `label`, then `value`, then the primitive. Capitalises
 * lowercase enum tokens so "donor, volunteer" reads as "Donor, Volunteer".
 * The chip already has `max-w-full truncate`, so long joined strings are
 * clipped with an ellipsis (full text in the title tooltip).
 */
function formatArrayValue(value: unknown[]): string {
  return value
    .map((v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        if (typeof obj.label === "string") return obj.label;
        if (typeof obj.value === "string") return obj.value;
        return String(v);
      }
      if (typeof v === "string" && v.length > 0 && v === v.toLowerCase()) {
        return v.charAt(0).toUpperCase() + v.slice(1);
      }
      return String(v);
    })
    .join(", ");
}

/**
 * Visual representation of an active filter — either a hand-built condition
 * (field + operator + value) or a BE pattern flag from a quick template.
 *
 * Pattern chips carry a sparkle icon and a soft primary tint so operators can
 * tell at a glance "this came from a quick template, not a hand-built
 * condition". Conditions render unchanged.
 */
export function FilterChip({ filter, onRemove }: FilterChipProps) {
  const t = useTranslations("constituents.filters");
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
            aria-label={`Remove ${displayLabel} filter`}
          >
            <X size={12} aria-hidden="true" />
          </Button>
        )}
      </Badge>
    );
  }

  const formatValue = (value: unknown): string => {
    if (Array.isArray(value)) {
      if (value.length === 2 && filter.operator === "between") {
        // Format date range
        if (typeof value[0] === "string" && value[0].match(/\d{4}-\d{2}-\d{2}/)) {
          return `${new Date(value[0]).toLocaleDateString()} - ${new Date(value[1]).toLocaleDateString()}`;
        }
        return `${value[0]} - ${value[1]}`;
      }
      return formatArrayValue(value);
    }

    if (typeof value === "boolean") {
      return value ? t("yes") : t("no");
    }

    if (typeof value === "string" && value.match(/\d{4}-\d{2}-\d{2}/)) {
      return new Date(value).toLocaleDateString();
    }

    return String(value);
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
          aria-label={`Remove ${displayLabel} filter`}
        >
          <X size={12} aria-hidden="true" />
        </Button>
      )}
    </Badge>
  );
}
