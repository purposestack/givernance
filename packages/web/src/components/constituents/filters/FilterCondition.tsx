"use client";

import { Check, ChevronDown, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckboxVisual } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClientApiClient } from "@/lib/api/client-browser";
import { cn } from "@/lib/utils";
import { filterFields, getOperatorLabel } from "./filter-presets";
import {
  type FilterCategory,
  type FilterCondition as FilterConditionType,
  type FilterField,
  type FilterOperator,
  type FilterValue,
  isNullaryOperator,
} from "./filter-types";

/**
 * next-intl statically validates message keys at compile-time; field /
 * operator / option labels stored in `filterFields` and returned by
 * `getOperatorLabel` are dynamic strings that can't be narrowed to the
 * strict `NamespacedMessageKeys` union. Cast once at the call site — same
 * papercut as `campaign-members-card.tsx`. Runtime safety: every key below
 * is checked into `en.json`/`fr.json` and the `pnpm check:translations`
 * script asserts EN/FR parity in CI.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(t: StrictTranslator, key: string, values?: Record<string, string | number>) {
  return (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
}

/**
 * Operators that take a SET of values rather than a single value. When a
 * condition uses one of these, the value input becomes a real multi-select
 * (Popover + Checkboxes) so the operator's "any of …" semantics map to a
 * `string[]` payload the BE expects.
 */
const MULTI_VALUE_OPERATORS = new Set<FilterOperator>([
  "in",
  // Array-column operators (issue #465) — both take a SET of values rendered
  // through the same Popover + Checkbox multiselect.
  "arrayContains",
  "arrayOverlaps",
]);

function isMultiValueOperator(op: FilterOperator): boolean {
  return MULTI_VALUE_OPERATORS.has(op);
}

/**
 * Seed value for a freshly-selected field's default operator: nullary → null
 * (no input), multi-value → [], between → ["",""], boolean → false, else "".
 * Extracted out of `handleFieldChange` to keep that handler under the Biome
 * cognitive-complexity ceiling.
 */
function seedValueForOperator(
  operator: FilterOperator,
  fieldType: FilterField["type"],
): FilterValue {
  if (isNullaryOperator(operator)) return null;
  if (isMultiValueOperator(operator)) return [];
  if (operator === "between") return ["", ""];
  if (fieldType === "boolean") return false;
  return "";
}

/**
 * When the operator switches between single- and multi-value semantics, the
 * stored value must be reshaped so the BE still accepts it: `eq` "donor"
 * becomes `in` ["donor"], and switching back unwraps the first element.
 * Extracted out of `handleOperatorChange` to keep that handler under the
 * Biome cognitive-complexity ceiling.
 */
function reshapeValueForOperator(
  current: FilterValue,
  fromOp: FilterOperator,
  toOp: FilterOperator,
): FilterValue {
  if (toOp === "between") return ["", ""];
  // Presence checks (isNull / isNotNull) take no value.
  if (isNullaryOperator(toOp)) return null;

  const goingMulti = isMultiValueOperator(toOp);
  const wasMulti = isMultiValueOperator(fromOp);
  if (goingMulti === wasMulti) return current;

  if (goingMulti) {
    if (typeof current === "string" && current !== "") return [current];
    if (typeof current === "number") return [String(current)];
    return [];
  }
  // Unwrap array → scalar.
  const arr = Array.isArray(current) ? current : [];
  const first = arr[0];
  return typeof first === "string" || typeof first === "number" ? String(first) : "";
}

interface FilterConditionProps {
  condition: FilterConditionType;
  onChange: (condition: FilterConditionType) => void;
  onRemove: () => void;
}

/**
 * Single filter condition editor with field, operator, and value inputs.
 */
export function FilterCondition({ condition, onChange, onRemove }: FilterConditionProps) {
  const t = useTranslations("constituents.filters");

  const selectedField = filterFields.find((f) => f.name === condition.field);
  const availableOperators = selectedField?.operators || ["eq"];

  // Tenant-defined option lists (e.g. tags) fetched at edit-time from the
  // suggestions endpoint. Empty for fields with a static picklist.
  const [asyncOptions, setAsyncOptions] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    if (!selectedField?.asyncSuggestions) {
      setAsyncOptions([]);
      return;
    }
    let cancelled = false;
    const fieldName = selectedField.name;
    void (async () => {
      try {
        const client = createClientApiClient();
        const res = await client.get<{ data: string[] }>(
          `/v1/constituents/filter/suggestions?field=${encodeURIComponent(fieldName)}`,
        );
        if (!cancelled) setAsyncOptions((res.data ?? []).map((v) => ({ value: v, label: v })));
      } catch {
        // Suggestions are best-effort: on failure the multiselect just shows
        // no options; isNull/isNotNull on the same field still work.
        if (!cancelled) setAsyncOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedField?.asyncSuggestions, selectedField?.name]);

  // Resolve the option list for a field: fetched suggestions for async fields,
  // otherwise the static picklist. Async option labels are the raw value.
  const optionsFor = (field: FilterField): Array<{ value: string; label: string }> =>
    field.asyncSuggestions ? asyncOptions : (field.options ?? []);

  const handleFieldChange = (fieldName: string) => {
    const field = filterFields.find((f) => f.name === fieldName);
    if (field) {
      // Reset operator and seed a value shaped for that operator when the field changes.
      const defaultOp = field.operators[0] || "eq";
      const seedValue = seedValueForOperator(defaultOp, field.type);
      onChange({
        ...condition,
        field: fieldName,
        operator: defaultOp,
        value: seedValue,
      });
    }
  };

  const handleOperatorChange = (operator: FilterOperator) => {
    const nextValue = reshapeValueForOperator(condition.value, condition.operator, operator);
    onChange({ ...condition, operator, value: nextValue });
  };

  const handleValueChange = (value: FilterValue) => {
    onChange({
      ...condition,
      value,
    });
  };

  const renderBetweenInput = (selectedField: FilterField) => {
    const rawValues = Array.isArray(condition.value) ? condition.value : ["", ""];
    const values: [string, string] = [String(rawValues[0] ?? ""), String(rawValues[1] ?? "")];
    const fieldLabel = trDynamic(t, selectedField.label);
    if (selectedField.type === "date") {
      return (
        <div className="flex gap-2 items-center">
          <Input
            type="date"
            value={values[0]}
            onChange={(e) => handleValueChange([e.target.value, values[1]])}
            className="flex-1"
            aria-label={t("startDate")}
          />
          <span className="text-sm text-on-surface-variant">{t("rangeSeparator")}</span>
          <Input
            type="date"
            value={values[1]}
            onChange={(e) => handleValueChange([values[0], e.target.value])}
            className="flex-1"
            aria-label={t("endDate")}
          />
        </div>
      );
    }
    const placeholder = selectedField.placeholder
      ? trDynamic(t, selectedField.placeholder)
      : t("rangeFrom");
    const placeholderTo = selectedField.placeholder
      ? trDynamic(t, selectedField.placeholder)
      : t("rangeTo");
    return (
      <div className="flex gap-2 items-center">
        <Input
          type={selectedField.type === "number" ? "number" : "text"}
          value={values[0]}
          onChange={(e) => handleValueChange([e.target.value, values[1]])}
          placeholder={placeholder}
          min={selectedField.min}
          max={selectedField.max}
          step={selectedField.step}
          className="flex-1"
          aria-label={t("rangeStart", { field: fieldLabel })}
        />
        <span className="text-sm text-on-surface-variant">{t("rangeSeparator")}</span>
        <Input
          type={selectedField.type === "number" ? "number" : "text"}
          value={values[1]}
          onChange={(e) => handleValueChange([values[0], e.target.value])}
          placeholder={placeholderTo}
          min={selectedField.min}
          max={selectedField.max}
          step={selectedField.step}
          className="flex-1"
          aria-label={t("rangeEnd", { field: fieldLabel })}
        />
      </div>
    );
  };

  const renderSelectInput = (selectedField: FilterField) => (
    <Select
      value={typeof condition.value === "string" ? condition.value : ""}
      onValueChange={handleValueChange}
    >
      <SelectTrigger
        className="w-full"
        aria-label={t("selectValueFor", { field: trDynamic(t, selectedField.label) })}
      >
        <SelectValue placeholder={t("selectValue")} />
      </SelectTrigger>
      <SelectContent>
        {selectedField.options?.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {trDynamic(t, option.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  /**
   * Real multi-select: Popover-anchored checkbox list whose committed value
   * is a `string[]`. Used whenever the active operator is one of
   * `MULTI_VALUE_OPERATORS` (e.g. `in` for `constituent.type`), regardless of
   * the field's nominal `type` — so a `select` field whose operator is
   * switched to `in` picks up multi-select behaviour automatically.
   */
  const renderMultiselectInput = (selectedField: FilterField) => {
    const catalogueOptions = optionsFor(selectedField);
    const selectedValues = Array.isArray(condition.value)
      ? (condition.value as Array<string | number>).map(String)
      : [];
    const selectedSet = new Set(selectedValues);

    // Async suggestions return a bounded page (top-N). Union already-selected
    // values that aren't in that page so a previously-picked tag stays visible
    // and removable instead of vanishing (and looking un-deselectable).
    const fieldOptions = [
      ...catalogueOptions,
      ...selectedValues
        .filter((v) => !catalogueOptions.some((o) => o.value === v))
        .map((v) => ({ value: v, label: v })),
    ];

    const toggleValue = (value: string) => {
      const next = new Set(selectedSet);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      handleValueChange(Array.from(next));
    };

    const triggerLabel =
      selectedValues.length === 0
        ? t("selectValues")
        : selectedValues.length <= 2
          ? fieldOptions
              .filter((opt) => selectedSet.has(opt.value))
              .map((opt) => trDynamic(t, opt.label))
              .join(", ")
          : t("selectValuesCount", { count: selectedValues.length });

    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              selectedValues.length === 0 && "text-on-surface-variant",
            )}
            aria-label={t("selectValuesFor", { field: trDynamic(t, selectedField.label) })}
          >
            <span className="truncate text-left">{triggerLabel}</span>
            <ChevronDown size={16} aria-hidden="true" className="shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          <ul className="max-h-64 overflow-y-auto">
            {fieldOptions.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-on-surface-variant">{t("noOptions")}</li>
            ) : null}
            {fieldOptions.map((option) => {
              const checked = selectedSet.has(option.value);
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    onClick={() => toggleValue(option.value)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-container-low focus-visible:outline-none focus-visible:bg-surface-container-low"
                    aria-pressed={checked}
                  >
                    <CheckboxVisual checked={checked} />
                    <span className="flex-1 truncate">{trDynamic(t, option.label)}</span>
                    {checked ? <Check size={14} aria-hidden="true" className="opacity-60" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    );
  };

  const renderBooleanInput = (selectedField: FilterField) => (
    <Select
      value={String(condition.value)}
      onValueChange={(value) => handleValueChange(value === "true")}
    >
      <SelectTrigger
        className="w-full"
        aria-label={t("selectBooleanFor", { field: trDynamic(t, selectedField.label) })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true">{t("yes")}</SelectItem>
        <SelectItem value="false">{t("no")}</SelectItem>
      </SelectContent>
    </Select>
  );

  const renderDefaultInput = (selectedField: FilterField) => {
    const stringValue =
      typeof condition.value === "string" || typeof condition.value === "number"
        ? String(condition.value)
        : "";
    const placeholder = selectedField.placeholder
      ? trDynamic(t, selectedField.placeholder)
      : t("enterValue");
    return (
      <Input
        type={
          selectedField.type === "number"
            ? "number"
            : selectedField.type === "date"
              ? "date"
              : "text"
        }
        value={stringValue}
        onChange={(e) => handleValueChange(e.target.value)}
        placeholder={placeholder}
        min={selectedField.min}
        max={selectedField.max}
        step={selectedField.step}
        className="w-full"
        aria-label={t("enterValueFor", { field: trDynamic(t, selectedField.label) })}
      />
    );
  };

  const renderValueInput = () => {
    if (!selectedField) return null;

    // Presence checks (isNull / isNotNull) take no value — render nothing.
    if (isNullaryOperator(condition.operator)) {
      return null;
    }

    if (condition.operator === "between") return renderBetweenInput(selectedField);

    const hasOptions =
      selectedField.options !== undefined || selectedField.asyncSuggestions === true;

    // Multi-value operators (in / arrayContains / arrayOverlaps) take precedence
    // over the field's nominal `type` — a `select` field with the `in` operator
    // picks one-or-many. Falls back to the single-value renderers otherwise.
    if (isMultiValueOperator(condition.operator) && hasOptions) {
      return renderMultiselectInput(selectedField);
    }

    if (selectedField.type === "select" && hasOptions) return renderSelectInput(selectedField);
    if (selectedField.type === "multiselect" && hasOptions)
      return renderMultiselectInput(selectedField);
    if (selectedField.type === "boolean") return renderBooleanInput(selectedField);

    return renderDefaultInput(selectedField);
  };

  const fieldsByCategory = filterFields.reduce<Record<FilterCategory, FilterField[]>>(
    (acc, field) => {
      const bucket = acc[field.category] ?? [];
      bucket.push(field);
      acc[field.category] = bucket;
      return acc;
    },
    {} as Record<FilterCategory, FilterField[]>,
  );
  const categoryEntries = Object.entries(fieldsByCategory) as Array<
    [FilterCategory, FilterField[]]
  >;

  return (
    <div className="flex gap-2 items-start" data-testid={`filter-condition-${condition.id}`}>
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
        {/* Field selector */}
        <Select value={condition.field} onValueChange={handleFieldChange}>
          <SelectTrigger aria-label={t("selectField")}>
            <SelectValue placeholder={t("selectField")} />
          </SelectTrigger>
          <SelectContent>
            {categoryEntries.map(([category, fields]) => (
              <div key={category}>
                <div className="px-2 py-1.5 text-sm font-semibold text-on-surface-variant">
                  {t(`categories.${category}`)}
                </div>
                {fields.map((field) => (
                  <SelectItem key={field.name} value={field.name}>
                    {trDynamic(t, field.label)}
                  </SelectItem>
                ))}
              </div>
            ))}
          </SelectContent>
        </Select>

        {/* Operator selector */}
        <Select
          value={condition.operator}
          onValueChange={handleOperatorChange}
          disabled={!condition.field}
        >
          <SelectTrigger aria-label={t("selectOperator")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableOperators.map((op) => (
              <SelectItem key={op} value={op}>
                {trDynamic(t, getOperatorLabel(op))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Value input */}
        {renderValueInput()}
      </div>

      {/* Remove button */}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRemove}
        aria-label={t("removeCondition")}
        className="mt-1"
      >
        <Trash2 size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
