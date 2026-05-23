// @ts-nocheck
"use client";

import { Button } from "@/components/ui/button";
import type { FilterQuery } from "@/services/PostalCampaignService";

interface FilterModeProps {
  filterQuery: FilterQuery | null;
  previewCount: number | null;
  previewLoading: boolean;
  adding: boolean;
  progress: number;
  onFilterChange: (filter: FilterQuery) => void;
  onAdd: () => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  ProgressDisplay: React.FC<{
    progress: number;
    t: (key: string, values?: Record<string, unknown>) => string;
  }>;
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
  // Check if FilterBuilder component exists
  const FilterBuilder =
    typeof window !== "undefined" ? (window as Record<string, unknown>).FilterBuilder : null;

  return (
    <div className="space-y-4">
      {FilterBuilder ? (
        <FilterBuilder
          onChange={onFilterChange}
          previewCount={previewCount}
          previewLoading={previewLoading}
          embedded
        />
      ) : (
        <div className="rounded-lg border border-dashed border-outline-variant p-8 text-center">
          <p className="text-sm text-on-surface-variant">{t("filterBuilderLoading")}</p>
        </div>
      )}

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
