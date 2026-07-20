"use client";

import type { CustomFieldDefinition, CustomFieldValue } from "@givernance/shared/custom-fields";
import { Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AmountInput } from "@/components/shared/amount-input";
import { Checkbox, CheckboxVisual } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { customOptionLabel } from "./definitions";

/** Sentinel for "no option picked" — Radix Select rejects empty-string values. */
const NONE_OPTION = "__none__";

export interface CustomFieldInputProps {
  definition: CustomFieldDefinition;
  /** Current value (`undefined`/`null` = empty). */
  value: CustomFieldValue | null | undefined;
  /** `null` = cleared. The parent owns the values map + merge-patch build. */
  onChange: (value: CustomFieldValue | null) => void;
  id?: string;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * Renders one custom-field editor from its definition (Epic #539) by mapping
 * `definition.type` onto the existing form primitives — Input, Textarea,
 * AmountInput (currency = integer cents), date input, Select, and the
 * Popover+checkbox multi-select. Option and field labels are operator data
 * rendered literally (never through next-intl); only chrome strings
 * (placeholders, counts) are i18n. Validation is server-authoritative — this
 * component only shapes values.
 */
export function CustomFieldInput({
  definition,
  value,
  onChange,
  id,
  invalid,
  disabled,
}: CustomFieldInputProps) {
  switch (definition.type) {
    case "text":
      return (
        <Input
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          maxLength={2000}
          aria-invalid={invalid}
          disabled={disabled}
        />
      );
    case "long_text":
      return (
        <Textarea
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          maxLength={10000}
          rows={4}
          aria-invalid={invalid}
          disabled={disabled}
        />
      );
    case "number":
      return (
        <NumberInput
          id={id}
          value={typeof value === "number" ? value : null}
          onChange={onChange}
          invalid={invalid}
          disabled={disabled}
        />
      );
    case "currency":
      return (
        <AmountInput
          id={id}
          value={typeof value === "number" ? value : null}
          onChange={(cents) => onChange(cents === null ? null : cents)}
          aria-invalid={invalid}
          disabled={disabled}
        />
      );
    case "date":
      return (
        <Input
          id={id}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          aria-invalid={invalid}
          disabled={disabled}
        />
      );
    case "boolean":
      return (
        <BooleanInput
          id={id}
          definition={definition}
          checked={value === true}
          onChange={onChange}
          invalid={invalid}
          disabled={disabled}
        />
      );
    case "picklist":
      return (
        <PicklistInput
          id={id}
          definition={definition}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          invalid={invalid}
          disabled={disabled}
        />
      );
    case "multi_picklist":
      return (
        <MultiPicklistInput
          definition={definition}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          invalid={invalid}
          disabled={disabled}
        />
      );
    default:
      return null;
  }
}

/**
 * Number editor with a local raw-string buffer so partially-typed decimals
 * ("3.", "-") survive re-renders; only finite parses propagate upward.
 */
function NumberInput({
  id,
  value,
  onChange,
  invalid,
  disabled,
}: {
  id?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useState<string>(value === null ? "" : String(value));
  return (
    <Input
      id={id}
      type="number"
      step="any"
      value={raw}
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        if (next.trim() === "") {
          onChange(null);
          return;
        }
        const parsed = Number(next);
        onChange(Number.isFinite(parsed) ? parsed : null);
      }}
      aria-invalid={invalid}
      disabled={disabled}
    />
  );
}

function BooleanInput({
  id,
  definition,
  checked,
  onChange,
  invalid,
  disabled,
}: {
  id?: string;
  definition: CustomFieldDefinition;
  checked: boolean;
  onChange: (value: boolean | null) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("customFields");
  return (
    <label
      htmlFor={id}
      className="flex h-[var(--input-height)] w-fit cursor-pointer items-center gap-2 text-sm text-on-surface"
    >
      <Checkbox
        id={id}
        checked={checked}
        // An unchecked box clears the key (absent ≡ false for operators) so a
        // never-touched boolean doesn't force a stored `false` into the blob.
        onCheckedChange={(next) => onChange(next === true ? true : null)}
        aria-invalid={invalid}
        aria-label={definition.label}
        disabled={disabled}
      />
      <span className="text-on-surface-variant">
        {checked ? t("boolean.yes") : t("boolean.no")}
      </span>
    </label>
  );
}

function PicklistInput({
  id,
  definition,
  value,
  onChange,
  invalid,
  disabled,
}: {
  id?: string;
  definition: CustomFieldDefinition;
  value: string;
  onChange: (value: string | null) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("customFields");
  const activeOptions = [...definition.options]
    .filter((o) => o.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  // A stored value pointing at a deactivated/merged option stays visible (and
  // clearable) instead of silently vanishing — the server rejects NEW writes
  // of inactive ids, but existing values must remain readable.
  const staleSelection = value !== "" && !activeOptions.some((o) => o.id === value);

  return (
    <Select
      value={value === "" ? NONE_OPTION : value}
      onValueChange={(next) => onChange(next === NONE_OPTION ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-invalid={invalid} aria-label={definition.label}>
        <SelectValue placeholder={t("input.selectPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_OPTION}>{t("input.noValue")}</SelectItem>
        {staleSelection ? (
          <SelectItem value={value}>{customOptionLabel(definition, value)}</SelectItem>
        ) : null}
        {activeOptions.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MultiPicklistInput({
  definition,
  value,
  onChange,
  invalid,
  disabled,
}: {
  definition: CustomFieldDefinition;
  value: string[];
  onChange: (value: string[] | null) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("customFields");
  const selected = new Set(value.map(String));
  const activeOptions = [...definition.options]
    .filter((o) => o.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  // Union stored-but-inactive ids so previously-picked options stay visible
  // and removable (same posture as the picklist above).
  const displayOptions = [
    ...activeOptions,
    ...value
      .filter((v) => !activeOptions.some((o) => o.id === v))
      .map((v) => ({ id: v, label: customOptionLabel(definition, v) })),
  ];

  const toggle = (optionId: string) => {
    const next = new Set(selected);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    const nextValues = displayOptions.map((o) => o.id).filter((oid) => next.has(oid));
    onChange(nextValues.length === 0 ? null : nextValues);
  };

  const triggerLabel =
    value.length === 0
      ? t("input.selectPlaceholder")
      : value.length <= 2
        ? displayOptions
            .filter((o) => selected.has(o.id))
            .map((o) => o.label)
            .join(", ")
        : t("input.selectedCount", { count: value.length });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-invalid={invalid}
          aria-label={definition.label}
          className={cn(
            "inline-flex h-[var(--input-height)] w-full items-center justify-between gap-2 rounded-[var(--radius-input)] border border-outline-variant bg-surface-container-lowest px-3 text-base",
            "transition-[border-color,box-shadow] duration-normal ease-out",
            "focus:outline-none focus:border-primary focus:shadow-ring",
            "aria-invalid:border-error aria-invalid:focus:shadow-ring-error",
            "disabled:cursor-not-allowed disabled:opacity-50",
            value.length === 0 && "text-text-muted",
          )}
        >
          <span className="truncate text-left">{triggerLabel}</span>
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        <ul className="max-h-64 overflow-y-auto">
          {displayOptions.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-on-surface-variant">{t("input.noOptions")}</li>
          ) : null}
          {displayOptions.map((option) => {
            const checked = selected.has(option.id);
            return (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => toggle(option.id)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-container-low focus-visible:outline-none focus-visible:bg-surface-container-low"
                  aria-pressed={checked}
                >
                  <CheckboxVisual checked={checked} />
                  <span className="flex-1 truncate">{option.label}</span>
                  {checked ? <Check size={14} aria-hidden="true" className="opacity-60" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
