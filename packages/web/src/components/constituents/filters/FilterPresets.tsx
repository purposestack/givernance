"use client";

import * as Icons from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { type FilterPreset } from "./filter-types";
import { FILTER_PRESETS } from "./filter-presets";

interface FilterPresetsProps {
  onSelect: (preset: FilterPreset) => void;
  className?: string;
  /** Show as a dropdown or inline grid */
  display?: "dropdown" | "grid";
}

/**
 * Pre-defined filter template selector.
 * Displays common nonprofit queries like LYBUNT, major donors, etc.
 */
export function FilterPresets({ onSelect, className, display = "dropdown" }: FilterPresetsProps) {
  const t = useTranslations("constituents.filters.presets");

  // Group presets by category
  const groupedPresets = useMemo(() => {
    const groups: Record<string, FilterPreset[]> = {};
    FILTER_PRESETS.forEach((preset) => {
      const category = preset.category || "other";
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(preset);
    });
    return groups;
  }, []);

  if (display === "grid") {
    return (
      <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
        {Object.entries(groupedPresets).map(([category, presets]) => (
          <div key={category}>
            <h4 className="mb-2 text-sm font-medium uppercase tracking-wide text-on-surface-variant">
              {t(`categories.${category}`)}
            </h4>
            <div className="space-y-2">
              {presets.map((preset) => (
                <PresetCard key={preset.key} preset={preset} onSelect={onSelect} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className={className}>
          <Icons.Sparkles size={16} className="mr-1.5" />
          {t("trigger")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {Object.entries(groupedPresets).map(([category, presets], index) => (
          <DropdownMenuGroup key={category}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs">
              {t(`categories.${category}`)}
            </DropdownMenuLabel>
            {presets.map((preset) => {
              const Icon = preset.icon ? Icons[preset.icon as keyof typeof Icons] : null;
              return (
                <DropdownMenuItem
                  key={preset.key}
                  onClick={() => onSelect(preset)}
                  className="cursor-pointer"
                >
                  {Icon ? <Icon size={16} className="mr-2" /> : null}
                  <div className="flex-1">
                    <div className="font-medium">{preset.name}</div>
                    {preset.description ? (
                      <div className="text-xs text-on-surface-variant">{preset.description}</div>
                    ) : null}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface PresetCardProps {
  preset: FilterPreset;
  onSelect: (preset: FilterPreset) => void;
}

function PresetCard({ preset, onSelect }: PresetCardProps) {
  const Icon = preset.icon ? Icons[preset.icon as keyof typeof Icons] : null;

  return (
    <button
      onClick={() => onSelect(preset)}
      className="w-full rounded-lg border border-outline-variant bg-surface p-3 text-left transition-colors hover:bg-surface-container-low focus-visible:outline-none focus-visible:shadow-ring"
    >
      <div className="flex items-start gap-3">
        {Icon ? (
          <div className="rounded-full bg-primary-container p-2 text-on-primary-container">
            <Icon size={16} />
          </div>
        ) : null}
        <div className="flex-1">
          <h5 className="font-medium text-on-surface">{preset.name}</h5>
          {preset.description ? (
            <p className="mt-0.5 text-xs text-on-surface-variant">{preset.description}</p>
          ) : null}
        </div>
      </div>
    </button>
  );
}