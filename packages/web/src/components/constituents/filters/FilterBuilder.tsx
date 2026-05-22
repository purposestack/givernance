"use client";

import { Plus, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { FilterChip, FilterChipGroup } from "./FilterChip";
import { FilterPresets } from "./FilterPresets";
import {
  CONSTITUENT_FILTER_FIELDS,
  type Filter,
  type FilterCondition,
  type FilterField,
  type FilterLogic,
  type FilterOperator,
  type FilterPreset,
  formatOperator,
  getFieldConfig,
} from "./filter-types";

interface FilterBuilderProps {
  /** Current filter state */
  filter: Filter | null;
  /** Callback when filter changes */
  onChange: (filter: Filter | null) => void;
  /** Show live count of matching constituents */
  showCount?: boolean;
  /** Current count of matching constituents */
  matchCount?: number;
  /** Loading state for count */
  countLoading?: boolean;
  /** Compact mode for inline display */
  compact?: boolean;
  className?: string;
}

/**
 * Main interface for creating and editing constituent filters.
 * Provides both a visual builder and preset templates.
 */
export function FilterBuilder({
  filter,
  onChange,
  showCount = true,
  matchCount = 0,
  countLoading = false,
  compact = false,
  className,
}: FilterBuilderProps) {
  const t = useTranslations("constituents.filters");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCondition, setEditingCondition] = useState<FilterCondition | null>(null);

  const handleAddCondition = useCallback(
    (condition: FilterCondition) => {
      const newFilter: Filter = filter
        ? {
            ...filter,
            conditions: [...filter.conditions, condition],
          }
        : {
            id: crypto.randomUUID(),
            conditions: [condition],
            logic: "AND",
          };
      onChange(newFilter);
    },
    [filter, onChange],
  );

  const handleRemoveCondition = useCallback(
    (conditionId: string) => {
      if (!filter) return;
      const newConditions = filter.conditions.filter((c) => c.id !== conditionId);
      if (newConditions.length === 0) {
        onChange(null);
      } else {
        onChange({ ...filter, conditions: newConditions });
      }
    },
    [filter, onChange],
  );

  const handleApplyPreset = useCallback(
    (preset: FilterPreset) => {
      onChange({
        ...preset,
        id: crypto.randomUUID(),
      });
    },
    [onChange],
  );

  const handleToggleLogic = useCallback(() => {
    if (!filter) return;
    onChange({
      ...filter,
      logic: filter.logic === "AND" ? "OR" : "AND",
    });
  }, [filter, onChange]);

  const hasConditions = filter && filter.conditions.length > 0;

  if (compact) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {hasConditions ? (
          <>
            <FilterChipGroup
              conditions={filter.conditions}
              onRemove={handleRemoveCondition}
              logic={filter.logic}
              variant="compact"
              maxVisible={3}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDialogOpen(true)}
              className="h-7"
            >
              <Plus size={14} />
            </Button>
            {showCount && !countLoading && (
              <span className="text-sm text-on-surface-variant">
                {t("matchCount", { count: matchCount })}
              </span>
            )}
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDialogOpen(true)}
            className="h-7"
          >
            <Search size={14} className="mr-1.5" />
            {t("addFilter")}
          </Button>
        )}

        <ConditionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          condition={editingCondition}
          onSave={handleAddCondition}
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* Header with presets */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-on-surface">{t("title")}</h3>
        <div className="flex items-center gap-2">
          <FilterPresets onSelect={handleApplyPreset} />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <Plus size={16} className="mr-1.5" />
            {t("addCondition")}
          </Button>
        </div>
      </div>

      {/* Active filters */}
      {hasConditions ? (
        <div className="space-y-3 rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
          <div className="flex items-start justify-between">
            <FilterChipGroup
              conditions={filter.conditions}
              onRemove={handleRemoveCondition}
              logic={filter.logic}
            />
            {filter.conditions.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleLogic}
                className="ml-2"
              >
                {filter.logic}
              </Button>
            )}
          </div>
          {showCount && (
            <div className="flex items-center justify-between border-t border-outline-variant pt-3">
              <span className="text-sm text-on-surface-variant">
                {countLoading ? t("counting") : t("matchCount", { count: matchCount })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange(null)}
                className="text-error"
              >
                <X size={14} className="mr-1.5" />
                {t("clearAll")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-outline-variant p-8 text-center">
          <Search size={32} className="mx-auto mb-3 text-on-surface-variant opacity-50" />
          <p className="text-sm text-on-surface-variant">{t("empty")}</p>
          <p className="mt-1 text-xs text-on-surface-variant">{t("getStarted")}</p>
        </div>
      )}

      <ConditionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        condition={editingCondition}
        onSave={handleAddCondition}
      />
    </div>
  );
}

interface ConditionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  condition: FilterCondition | null;
  onSave: (condition: FilterCondition) => void;
}

function ConditionDialog({ open, onOpenChange, condition, onSave }: ConditionDialogProps) {
  const t = useTranslations("constituents.filters.condition");
  const [selectedField, setSelectedField] = useState<string>("");
  const [selectedOperator, setSelectedOperator] = useState<FilterOperator | "">("");
  const [value, setValue] = useState<any>("");
  const [valueEnd, setValueEnd] = useState<any>(""); // For "between" operator

  // Get available operators for selected field
  const fieldConfig = useMemo(
    () => getFieldConfig(selectedField),
    [selectedField],
  );

  const availableOperators = useMemo(
    () => fieldConfig?.operators || [],
    [fieldConfig],
  );

  // Reset operator when field changes
  useEffect(() => {
    if (fieldConfig && !fieldConfig.operators.includes(selectedOperator as FilterOperator)) {
      setSelectedOperator("");
    }
  }, [fieldConfig, selectedOperator]);

  // Initialize from existing condition
  useEffect(() => {
    if (condition) {
      setSelectedField(condition.field);
      setSelectedOperator(condition.operator);
      if (condition.operator === "between" && Array.isArray(condition.value)) {
        setValue(condition.value[0]);
        setValueEnd(condition.value[1]);
      } else {
        setValue(condition.value);
      }
    }
  }, [condition]);

  const handleSave = () => {
    if (!selectedField || !selectedOperator) return;

    const finalValue = selectedOperator === "between" ? [value, valueEnd] : value;
    
    const newCondition: FilterCondition = {
      id: condition?.id || crypto.randomUUID(),
      field: selectedField,
      operator: selectedOperator as FilterOperator,
      value: finalValue,
    };

    onSave(newCondition);
    onOpenChange(false);
    
    // Reset form
    setSelectedField("");
    setSelectedOperator("");
    setValue("");
    setValueEnd("");
  };

  const needsValue = selectedOperator && !["is_null", "is_not_null"].includes(selectedOperator);
  const isBetween = selectedOperator === "between";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{condition ? t("titleEdit") : t("titleAdd")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Field selection */}
          <div>
            <Label htmlFor="field">{t("field")}</Label>
            <Select value={selectedField} onValueChange={setSelectedField}>
              <SelectTrigger id="field">
                <SelectValue placeholder={t("selectField")} />
              </SelectTrigger>
              <SelectContent>
                {CONSTITUENT_FILTER_FIELDS.map((field) => (
                  <SelectItem key={field.key} value={field.key}>
                    {field.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Operator selection */}
          {selectedField && (
            <div>
              <Label htmlFor="operator">{t("operator")}</Label>
              <Select 
                value={selectedOperator} 
                onValueChange={(v) => setSelectedOperator(v as FilterOperator)}
              >
                <SelectTrigger id="operator">
                  <SelectValue placeholder={t("selectOperator")} />
                </SelectTrigger>
                <SelectContent>
                  {availableOperators.map((op) => (
                    <SelectItem key={op} value={op}>
                      {formatOperator(op)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Value input */}
          {needsValue && fieldConfig && (
            <div>
              <Label htmlFor="value">{t("value")}</Label>
              {fieldConfig.type === "enum" && fieldConfig.options ? (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger id="value">
                    <SelectValue placeholder={t("selectValue")} />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldConfig.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : fieldConfig.type === "number" ? (
                <>
                  <Input
                    id="value"
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value ? Number(e.target.value) : "")}
                    placeholder={isBetween ? t("valueFrom") : t("enterValue")}
                  />
                  {isBetween && (
                    <Input
                      type="number"
                      value={valueEnd}
                      onChange={(e) => setValueEnd(e.target.value ? Number(e.target.value) : "")}
                      placeholder={t("valueTo")}
                      className="mt-2"
                    />
                  )}
                </>
              ) : fieldConfig.type === "date" ? (
                <>
                  <Input
                    id="value"
                    type={selectedOperator.includes("days") ? "number" : "date"}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={isBetween ? t("dateFrom") : t("enterDate")}
                  />
                  {isBetween && (
                    <Input
                      type="date"
                      value={valueEnd}
                      onChange={(e) => setValueEnd(e.target.value)}
                      placeholder={t("dateTo")}
                      className="mt-2"
                    />
                  )}
                </>
              ) : (
                <Input
                  id="value"
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t("enterValue")}
                />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button 
            onClick={handleSave}
            disabled={!selectedField || !selectedOperator || (needsValue && !value)}
          >
            {condition ? t("update") : t("add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}