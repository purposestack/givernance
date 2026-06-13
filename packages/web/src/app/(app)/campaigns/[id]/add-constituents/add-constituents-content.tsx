// @ts-nocheck
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { ConstituentListRow } from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";
import { type FilterQuery, PostalCampaignService } from "@/services/PostalCampaignService";

import { FilterMode } from "./filter-mode";
import { SearchMode } from "./search-mode";

interface AddConstituentsContentProps {
  campaignId: string;
  mode: "filter" | "search";
}

// Helper function to handle errors
function getErrorMessage(err: unknown, t: (key: string) => string): string {
  return err instanceof ApiProblem
    ? (err.detail ?? err.title ?? t("errors.addFailed"))
    : t("errors.addFailed");
}

// Helper function to simulate progress
function startProgressInterval(setProgress: React.Dispatch<React.SetStateAction<number>>) {
  return setInterval(() => {
    setProgress((prev) => Math.min(prev + 10, 90));
  }, 200);
}

// Helper function to complete the add operation
function completeAddOperation(
  router: ReturnType<typeof useRouter>,
  campaignId: string,
  setProgress: React.Dispatch<React.SetStateAction<number>>,
) {
  setProgress(100);
  setTimeout(() => {
    router.push(`/campaigns/${campaignId}`);
    router.refresh();
  }, 500);
}

// Progress display component
function ProgressDisplay({ progress, t }: { progress: number; t: (key: string) => string }) {
  return (
    <div className="space-y-2">
      <Progress value={progress} />
      <p className="text-xs text-on-surface-variant text-center">{t("progress", { progress })}</p>
    </div>
  );
}

// Search result item component
function SearchResultItem({
  constituent,
  isSelected,
  onToggle,
}: {
  constituent: ConstituentListRow;
  isSelected: boolean;
  onToggle: (selected: boolean) => void;
}) {
  return (
    <li>
      <label className="flex items-center gap-3 px-3 py-2 hover:bg-surface-container cursor-pointer">
        <input type="checkbox" checked={isSelected} onChange={(e) => onToggle(e.target.checked)} />
        <div className="flex-1">
          <p className="text-sm font-medium text-on-surface">
            {constituent.firstName} {constituent.lastName}
          </p>
          {constituent.email && (
            <p className="text-xs text-on-surface-variant">{constituent.email}</p>
          )}
        </div>
      </label>
    </li>
  );
}

export function AddConstituentsContent({ campaignId, mode }: AddConstituentsContentProps) {
  const router = useRouter();
  const t = useTranslations("campaigns.addConstituents");

  const [filterQuery, setFilterQuery] = useState<FilterQuery | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConstituentListRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setSearchResults([]);
        return;
      }

      try {
        const client = createClientApiClient();
        const response = await ConstituentService.listConstituents(client, {
          search: query,
          perPage: 50,
        });
        setSearchResults(response.data);
      } catch {
        setSearchResults([]);
        toast.error(t("errors.searchFailed"));
      }
    },
    [t],
  );

  const handleFilterChange = useCallback(async (newFilter: FilterQuery) => {
    setFilterQuery(newFilter);

    // No conditions AND no pattern flags → nothing to preview. Pattern-only
    // presets (LYBUNT, RECURRING, …) ship `conditions: []` + `patterns: [...]`,
    // so they must still fetch a preview.
    const hasPatterns = (newFilter?.patterns?.length ?? 0) > 0;
    if (!newFilter || (newFilter.conditions.length === 0 && !hasPatterns)) {
      setPreviewCount(null);
      return;
    }

    setPreviewLoading(true);
    try {
      const client = createClientApiClient();
      const response = await client.post<{ data: { count: number; estimatedTime?: number } }>(
        "/v1/constituents/filter/preview",
        { query: newFilter },
      );
      setPreviewCount(response.data.count);
    } catch {
      // Swallow preview errors here — the inline FilterBuilder already shows
      // its own error state via `FilterPreview`. We just blank the count so
      // the "Add N constituents" CTA stays disabled.
      setPreviewCount(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const handleAddFromFilter = useCallback(async () => {
    if (!filterQuery || previewCount === 0) return;

    setAdding(true);
    setProgress(0);

    try {
      const client = createClientApiClient();
      const progressInterval = startProgressInterval(setProgress);

      const result = await PostalCampaignService.addMembersFromFilter(
        client,
        campaignId,
        filterQuery,
      );

      clearInterval(progressInterval);
      toast.success(
        t("success.addedFromFilter", {
          added: result.added,
          skipped: result.skipped,
        }),
      );

      completeAddOperation(router, campaignId, setProgress);
    } catch (err) {
      toast.error(getErrorMessage(err, t));
      setAdding(false);
      setProgress(0);
    }
  }, [campaignId, filterQuery, previewCount, router, t]);

  const handleAddFromSearch = useCallback(async () => {
    if (selectedIds.size === 0) return;

    setAdding(true);
    setProgress(0);

    try {
      const client = createClientApiClient();
      const progressInterval = startProgressInterval(setProgress);

      const result = await PostalCampaignService.addMembers(
        client,
        campaignId,
        Array.from(selectedIds),
      );

      clearInterval(progressInterval);
      toast.success(
        t("success.addedFromSearch", {
          added: result.added,
          skipped: result.skipped,
        }),
      );

      completeAddOperation(router, campaignId, setProgress);
    } catch (err) {
      toast.error(getErrorMessage(err, t));
      setAdding(false);
      setProgress(0);
    }
  }, [campaignId, selectedIds, router, t]);

  const toggleConstituent = useCallback((constituentId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(constituentId);
      } else {
        next.delete(constituentId);
      }
      return next;
    });
  }, []);

  if (mode === "filter") {
    return (
      <FilterMode
        filterQuery={filterQuery}
        previewCount={previewCount}
        previewLoading={previewLoading}
        adding={adding}
        progress={progress}
        onFilterChange={handleFilterChange}
        onAdd={handleAddFromFilter}
        t={t}
        ProgressDisplay={ProgressDisplay}
      />
    );
  }

  return (
    <SearchMode
      searchQuery={searchQuery}
      searchResults={searchResults}
      selectedIds={selectedIds}
      adding={adding}
      progress={progress}
      onSearchChange={setSearchQuery}
      onSearch={handleSearch}
      onToggleConstituent={toggleConstituent}
      onAdd={handleAddFromSearch}
      t={t}
      ProgressDisplay={ProgressDisplay}
      SearchResultItem={SearchResultItem}
    />
  );
}
