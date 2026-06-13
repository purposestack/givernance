// @ts-nocheck
"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { FilterBuilder, FilterChip, filterFields } from "@/components/constituents/filters";
import { isFilterCondition } from "@/components/constituents/filters/filter-types";
import { Button } from "@/components/ui/button";
import type { FilterQuery } from "@/services/PostalCampaignService";

interface FilterModeProps {
  filterQuery: FilterQuery | null;
  previewCount: number | null;
  previewLoading: boolean;
  adding: boolean;
  progress: number;
  onFilterChange: (filter: FilterQuery) => void | Promise<void>;
  onAdd: () => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  ProgressDisplay: React.FC<{
    progress: number;
    t: (key: string, values?: Record<string, unknown>) => string;
  }>;
}

/**
 * Build the chip list for the active-selection strip from a filter query.
 * Mirrors `FilterBuilder.getActiveFilters` so the summary shown here matches
 * the one inside the dialog.
 */
function getActiveFilters(query: FilterQuery | null) {
  if (!query) return [];
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
      const known = filterFields.find((f) => f.name === c.field);
      return {
        id: c.id,
        label: known?.label ?? c.field,
        field: c.field,
        operator: c.operator,
        value: c.value,
      };
    });
}

export function FilterMode({
  filterQuery,
  previewCount,
  previewLoading,
  adding,
  progress,
  onFilterChange,
  onAdd,
  t,
  ProgressDisplay,
}: FilterModeProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const activeFilters = getActiveFilters(filterQuery);
  const hasFilters = activeFilters.length > 0 || (filterQuery?.patterns?.length ?? 0) > 0;

  const handleApply = async (query: FilterQuery) => {
    await onFilterChange(query);
  };

  return (
    <div className="space-y-4">
      {hasFilters ? (
        <div className="space-y-3 rounded-lg border border-outline-variant bg-surface-container/40 p-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium text-on-surface">{t("activeFiltersTitle")}</p>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)}>
              <SlidersHorizontal size={16} aria-hidden="true" className="mr-2" />
              {t("editFilters")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeFilters.map((filter) => (
              <FilterChip key={filter.id} filter={filter} />
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-outline-variant p-8 text-center">
          <p className="mb-4 text-sm text-on-surface-variant">{t("noFiltersYet")}</p>
          <Button variant="secondary" onClick={() => setDialogOpen(true)}>
            <SlidersHorizontal size={16} aria-hidden="true" className="mr-2" />
            {t("configureFilters")}
          </Button>
        </div>
      )}

      <FilterBuilder
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onApply={handleApply}
        initialQuery={filterQuery ?? undefined}
      />

      {previewCount !== null && (
        <div className="rounded-lg bg-surface-container p-4">
          <p className="text-sm font-medium text-on-surface">
            {previewLoading
              ? t("previewLoading")
              : previewCount === 0
                ? t("previewEmpty")
                : previewCount > 1000
                  ? t("previewTooMany", { count: previewCount })
                  : t("previewCount", { count: previewCount })}
          </p>
        </div>
      )}

      {adding && <ProgressDisplay progress={progress} t={t} />}

      <Button
        onClick={() => void onAdd()}
        disabled={
          adding ||
          !filterQuery ||
          previewCount === null ||
          previewCount === 0 ||
          previewCount > 1000
        }
        className="w-full"
      >
        {adding ? t("actions.adding") : t("actions.addFiltered", { count: previewCount || 0 })}
      </Button>
    </div>
  );
}
