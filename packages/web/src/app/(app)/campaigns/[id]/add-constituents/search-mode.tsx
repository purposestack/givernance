"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConstituentListRow } from "@/models/constituent";

interface SearchModeProps {
  searchQuery: string;
  searchResults: ConstituentListRow[];
  selectedIds: Set<string>;
  adding: boolean;
  progress: number;
  onSearchChange: (value: string) => void;
  onSearch: (query: string) => void;
  onToggleConstituent: (id: string, selected: boolean) => void;
  onAdd: () => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  ProgressDisplay: React.FC<{
    progress: number;
    t: (key: string, values?: Record<string, unknown>) => string;
  }>;
  SearchResultItem: React.FC<{
    constituent: ConstituentListRow;
    isSelected: boolean;
    onToggle: (selected: boolean) => void;
  }>;
}

export function SearchMode({
  searchQuery,
  searchResults,
  selectedIds,
  adding,
  progress,
  onSearchChange,
  onSearch,
  onToggleConstituent,
  onAdd,
  t,
  ProgressDisplay,
  SearchResultItem,
}: SearchModeProps) {
  return (
    <div className="space-y-4">
      <Input
        type="search"
        placeholder={t("searchPlaceholder")}
        value={searchQuery}
        onChange={(e) => {
          onSearchChange(e.target.value);
          void onSearch(e.target.value);
        }}
      />

      {searchResults.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-outline-variant">
          <ul className="divide-y divide-outline-variant">
            {searchResults.map((constituent) => (
              <SearchResultItem
                key={constituent.id}
                constituent={constituent}
                isSelected={selectedIds.has(constituent.id)}
                onToggle={(selected) => onToggleConstituent(constituent.id, selected)}
              />
            ))}
          </ul>
        </div>
      )}

      {searchQuery && searchResults.length === 0 && (
        <p className="text-sm text-on-surface-variant text-center py-4">{t("searchEmpty")}</p>
      )}

      {adding && <ProgressDisplay progress={progress} t={t} />}

      <Button
        onClick={() => void onAdd()}
        disabled={adding || selectedIds.size === 0}
        className="w-full"
      >
        {adding ? t("actions.adding") : t("actions.addSelected", { count: selectedIds.size })}
      </Button>
    </div>
  );
}
