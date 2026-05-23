// @ts-nocheck
"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { FilterChip } from "./FilterChip";
import { FilterCondition } from "./FilterCondition";
import { FilterPresets } from "./FilterPresets";
import { FilterPreview } from "./FilterPreview";
import { filterFields } from "./filter-presets";
import {
  type FilterChipData,
  type FilterCondition as FilterConditionType,
  type FilterPreset,
  type FilterQuery,
  isFilterCondition,
  type LogicalOperator,
} from "./filter-types";
import "./filter-accessibility.css";

interface FilterBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Apply the built query. The optional `presetId` lets the parent surface a
   * "Filter preset: …" affordance in the active-selection strip — it carries
   * the id of the preset the operator clicked (if any) so the parent can
   * display the preset name without trying to fuzz-match the query back to a
   * preset. The id is cleared the moment the operator hand-edits any
   * condition or operator (so a customised preset doesn't keep claiming to be
   * "from preset X").
   */
  onApply: (query: FilterQuery, presetId?: string) => Promise<void>;
  initialQuery?: FilterQuery;
}

/**
 * Main filter builder dialog for creating complex constituent queries.
 */
export function FilterBuilder({ open, onOpenChange, onApply, initialQuery }: FilterBuilderProps) {
  const t = useTranslations("constituents.filters");
  useFocusReturn(open);

  const [query, setQuery] = useState<FilterQuery>(
    initialQuery || {
      operator: "AND",
      conditions: [],
    },
  );

  // Track which preset (if any) seeded the current query. Picking a preset
  // sets it; hand-editing any condition / operator afterwards clears it so
  // the parent's "Filter preset: …" affordance stays accurate. We only
  // forward the id to `onApply` — it never goes into the FilterQuery itself.
  const [activePresetId, setActivePresetId] = useState<string | undefined>(undefined);

  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [lastAnnouncedCount, setLastAnnouncedCount] = useState<number | null>(null);
  const liveRegionRef = useRef<HTMLDivElement>(null);

  const handleAddCondition = () => {
    const newCondition: FilterConditionType = {
      id: `${Date.now()}`,
      field: "",
      operator: "eq",
      value: "",
    };

    setQuery((prev) => ({
      ...prev,
      conditions: [...prev.conditions, newCondition],
    }));
    // Any hand-edit invalidates the "this came from preset X" claim.
    setActivePresetId(undefined);
  };

  const handleUpdateCondition = (index: number, condition: FilterConditionType) => {
    setQuery((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => (i === index ? condition : c)),
    }));
    setActivePresetId(undefined);
  };

  const handleRemoveCondition = (index: number) => {
    const removedCondition = query.conditions[index];
    setQuery((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }));
    setActivePresetId(undefined);

    // Announce removal to screen readers
    if (
      liveRegionRef.current &&
      removedCondition &&
      isFilterCondition(removedCondition) &&
      removedCondition.field
    ) {
      liveRegionRef.current.textContent = t("filterRemoved", { field: removedCondition.field });
    }
  };

  const handleOperatorChange = (operator: LogicalOperator) => {
    setQuery((prev) => ({
      ...prev,
      operator,
    }));
    setActivePresetId(undefined);
  };

  const handlePresetSelect = (preset: FilterPreset) => {
    setQuery(preset.query);
    setActivePresetId(preset.id);
    // `preset.name` is an i18n key (e.g. `presets.items.lybunt.name`); resolve
    // it through the same translator the toast uses so the operator sees
    // "Modèle appliqué : Donateurs récurrents" in FR rather than the key.
    toast.success(t("presetApplied", { name: t(preset.name) }));
  };

  // A query is "applyable" if it has at least one condition OR at least one
  // pattern flag. Pattern-only presets (LYBUNT, RECURRING, …) ship with
  // `conditions: []` + `patterns: ["…"]` and the BE now accepts them, so the
  // gate must allow that shape through.
  const hasAnyPattern = (query.patterns?.length ?? 0) > 0;
  const isApplyable = query.conditions.length > 0 || hasAnyPattern;

  const handleApply = async () => {
    // Validate that all conditions are complete
    const hasIncompleteConditions = query.conditions.some((c) => {
      if (!isFilterCondition(c)) return false;
      if (!c.field) return true;
      if (c.operator === "exists" || c.operator === "notExists") return false;
      if (Array.isArray(c.value)) {
        return c.value.some((v) => v === "" || v === null || v === undefined);
      }
      return c.value === "" || c.value === null || c.value === undefined;
    });

    if (hasIncompleteConditions) {
      toast.error(t("validation.incomplete"));
      return;
    }

    if (!isApplyable) {
      toast.error(t("validation.noConditions"));
      return;
    }

    setApplying(true);
    try {
      await onApply(query, activePresetId);
      onOpenChange(false);
      // Reset query on successful apply
      setQuery({ operator: "AND", conditions: [] });
      setActivePresetId(undefined);
    } catch (_error) {
      toast.error(t("applyError"));
    } finally {
      setApplying(false);
    }
  };

  const getActiveFilters = (): FilterChipData[] => {
    return query.conditions
      .filter(isFilterCondition)
      .filter(
        (c) =>
          c.field &&
          (c.operator === "exists" ||
            c.operator === "notExists" ||
            (Array.isArray(c.value) ? c.value.every((v) => v !== "") : c.value !== "")),
      )
      .map((c) => {
        // `label` carries the i18n key from `filterFields` (e.g.
        // `fields.donations.lastDate`). `FilterChip` resolves it through
        // `useTranslations("constituents.filters")`. Unknown fields (future
        // BE keys not yet catalogued FE-side) fall back to the raw field
        // name so the chip still renders something readable.
        const known = filterFields.find((f) => f.name === c.field);
        return {
          id: c.id,
          label: known?.label ?? c.field,
          field: c.field,
          operator: c.operator,
          value: c.value,
        };
      });
  };

  const activeFilters = getActiveFilters();

  // Update live region when preview count changes
  useEffect(() => {
    if (previewCount !== null && previewCount !== lastAnnouncedCount && liveRegionRef.current) {
      liveRegionRef.current.textContent = t("previewAnnouncement", { count: previewCount });
      setLastAnnouncedCount(previewCount);
    }
  }, [previewCount, lastAnnouncedCount, t]);

  // Handle Escape key to close dialog
  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, onOpenChange]);

  return (
    <>
      {/* Live region for screen reader announcements */}
      <div
        ref={liveRegionRef}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
          aria-label={t("title")}
        >
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-1">
            <div className="space-y-6 py-4">
              {/* Step 1 — Preset Templates */}
              <div className="space-y-2">
                <div>
                  <h3 className="text-sm font-semibold text-on-surface">{t("stepPresets")}</h3>
                  <p className="text-xs text-on-surface-variant">{t("stepPresetsHint")}</p>
                </div>
                <FilterPresets onSelect={handlePresetSelect} activePresetId={activePresetId} />
              </div>

              <Separator />

              {/* Step 2 — Custom Filters */}
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-on-surface">{t("customFilters")}</h3>
                    <p className="text-xs text-on-surface-variant">{t("customFiltersHint")}</p>
                  </div>
                  {query.conditions.length > 1 && (
                    <RadioGroup
                      value={query.operator}
                      onValueChange={(value) => handleOperatorChange(value as LogicalOperator)}
                      className="flex items-center gap-4"
                    >
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="AND" id="and" />
                        <Label htmlFor="and" className="text-sm cursor-pointer">
                          {t("operators.and")}
                        </Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="OR" id="or" />
                        <Label htmlFor="or" className="text-sm cursor-pointer">
                          {t("operators.or")}
                        </Label>
                      </div>
                    </RadioGroup>
                  )}
                </div>

                {/* Condition List */}
                {query.conditions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-outline-variant px-4 py-6 text-center">
                    <p className="text-sm text-on-surface-variant mb-3">{t("noConditions")}</p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleAddCondition}
                      aria-label={t("addFirstCondition")}
                    >
                      <Plus size={16} aria-hidden="true" className="mr-2" />
                      {t("addCondition")}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {query.conditions.filter(isFilterCondition).map((condition, index) => (
                      <div key={condition.id}>
                        {index > 0 && (
                          <div className="flex items-center gap-2 mb-3">
                            <div className="flex-1 h-px bg-outline-variant" />
                            <span className="text-xs font-medium text-on-surface-variant px-2">
                              {query.operator}
                            </span>
                            <div className="flex-1 h-px bg-outline-variant" />
                          </div>
                        )}
                        <FilterCondition
                          condition={condition}
                          onChange={(updated) => handleUpdateCondition(index, updated)}
                          onRemove={() => handleRemoveCondition(index)}
                          isFirst={index === 0}
                        />
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleAddCondition}
                      className="w-full"
                      aria-label={t("addAnotherCondition")}
                    >
                      <Plus size={16} aria-hidden="true" className="mr-2" />
                      {t("addCondition")}
                    </Button>
                  </div>
                )}
              </div>

              {/* Active Filters Summary */}
              {activeFilters.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div>
                      <h3 className="text-sm font-semibold text-on-surface">
                        {t("activeFilters")}
                      </h3>
                      <p className="text-xs text-on-surface-variant">{t("activeFiltersHint")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {activeFilters.map((filter) => (
                        <FilterChip
                          key={filter.id}
                          filter={filter}
                          onRemove={(id) => {
                            const index = query.conditions.findIndex((c) => c.id === id);
                            if (index >= 0) handleRemoveCondition(index);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Preview */}
              <div className="space-y-2">
                <div>
                  <h3 className="text-sm font-semibold text-on-surface">
                    {t("previewSectionTitle")}
                  </h3>
                  <p className="text-xs text-on-surface-variant">{t("previewSectionHint")}</p>
                </div>
                <FilterPreview
                  query={query}
                  onPreview={(response) => setPreviewCount(response.count)}
                />
              </div>
            </div>
          </div>

          <DialogFooter className="pt-4 border-t border-outline-variant">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleApply()} disabled={applying || !isApplyable}>
              {applying
                ? t("applying")
                : previewCount !== null
                  ? t("applyWithCount", { count: previewCount })
                  : t("apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
