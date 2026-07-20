import type {
  CustomFieldDefinition,
  CustomFieldValue as Value,
} from "@givernance/shared/custom-fields";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/format";
import { customOptionLabel, isEmptyCustomValue } from "./definitions";

export interface CustomFieldValueProps {
  definition: CustomFieldDefinition;
  /** Raw stored value (`undefined` = absent key = empty). */
  value: Value | null | undefined;
  locale: string;
  /**
   * Localised yes/no for boolean values. Callers resolve
   * `customFields.boolean.yes|no` in their own translation context (this
   * component stays hook-free so it renders in RSC detail pages AND table
   * cells alike); the FR fallback matches the app's default locale.
   */
  booleanLabels?: { yes: string; no: string };
}

/**
 * Read-side renderer for one custom-field value (Epic #539): cents formatted
 * as currency, option ids resolved to their operator-authored labels,
 * multi-picklists as chips, dates localised, empty as a muted em-dash.
 * Definition labels/options are tenant data rendered literally by contract.
 */
export function CustomFieldValue({
  definition,
  value,
  locale,
  booleanLabels = { yes: "Oui", no: "Non" },
}: CustomFieldValueProps) {
  if (isEmptyCustomValue(value)) {
    return <span className="text-on-surface-variant opacity-60">—</span>;
  }

  switch (definition.type) {
    case "currency":
      return typeof value === "number" ? (
        <span className="whitespace-nowrap font-mono tabular-nums">
          {formatCurrency(value, locale)}
        </span>
      ) : (
        <FallbackText value={value} />
      );
    case "date":
      return typeof value === "string" ? (
        <span className="whitespace-nowrap">{formatDate(value, locale, "short")}</span>
      ) : (
        <FallbackText value={value} />
      );
    case "boolean":
      return <span>{value === true ? booleanLabels.yes : booleanLabels.no}</span>;
    case "picklist":
      return typeof value === "string" ? (
        <span>{customOptionLabel(definition, value)}</span>
      ) : (
        <FallbackText value={value} />
      );
    case "multi_picklist":
      return Array.isArray(value) ? (
        <span className="flex flex-wrap gap-1">
          {value.map((optionId) => (
            <Badge key={optionId} variant="neutral" className="text-xs">
              {customOptionLabel(definition, optionId)}
            </Badge>
          ))}
        </span>
      ) : (
        <FallbackText value={value} />
      );
    case "long_text":
      return <span className="whitespace-pre-line break-words">{String(value)}</span>;
    default:
      return <FallbackText value={value} />;
  }
}

/**
 * Defensive path for a stored value whose shape drifted from its definition
 * type (e.g. the definition was archived + recreated with another type before
 * the value was rewritten). Render something readable, never crash a page.
 */
function FallbackText({ value }: { value: Value | null | undefined }) {
  return (
    <span className="break-words">{Array.isArray(value) ? value.join(", ") : String(value)}</span>
  );
}
