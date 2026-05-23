"use client";

import { Calendar, Check, Gift, MapPin, TrendingUp, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { filterPresets } from "./filter-presets";
import type { FilterPreset } from "./filter-types";

/**
 * next-intl statically validates message keys at compile-time; the
 * preset `name` / `description` fields hold dotted keys that can't be
 * narrowed to the strict `NamespacedMessageKeys` union. Cast once at
 * the call site — same papercut as `campaign-members-card.tsx`. Runtime
 * safety: every key below is checked into `en.json`/`fr.json` and the
 * `pnpm check:translations` script asserts EN/FR parity in CI.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(t: StrictTranslator, key: string) {
  return (t as unknown as (k: string) => string)(key);
}

interface FilterPresetsProps {
  onSelect: (preset: FilterPreset) => void;
  /**
   * Id of the preset that produced the current query (if any). When set, the
   * matching card renders with a primary-tinted background + Check icon so the
   * operator sees at a glance which template seeded the active selection.
   * Cleared by the parent the moment the user edits anything by hand
   * (FilterBuilder treats hand-edits as "Custom").
   */
  activePresetId?: string;
}

/**
 * Pre-defined filter template selector with common NPO segmentation patterns.
 */
export function FilterPresets({ onSelect, activePresetId }: FilterPresetsProps) {
  const t = useTranslations("constituents.filters");

  const getPresetIcon = (presetId: string) => {
    switch (presetId) {
      case "lybunt":
      case "new-donors":
      case "lapsed-donors":
        return <Calendar size={16} aria-hidden="true" />;
      case "major-donors":
        return <TrendingUp size={16} aria-hidden="true" />;
      case "recurring-monthly":
        return <Gift size={16} aria-hidden="true" />;
      case "local-geneva":
        return <MapPin size={16} aria-hidden="true" />;
      default:
        return <Users size={16} aria-hidden="true" />;
    }
  };

  // No duplicate title here — the parent FilterBuilder renders the step
  // header (e.g. "1. Start from a quick template") above this grid, so
  // rendering "Quick Templates" again read as visual noise.
  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {filterPresets.map((preset) => {
          const isActive = activePresetId === preset.id;
          return (
            <Button
              key={preset.id}
              type="button"
              // `whitespace-normal` + `min-w-0` override the Button base's
              // `whitespace-nowrap` so long preset names / descriptions wrap
              // instead of being clipped by the grid cell. The active card
              // tilts to the `default` (primary) variant so the selection is
              // obvious even when the chip strip is collapsed.
              variant={isActive ? "primary" : "secondary"}
              size="sm"
              className={cn(
                "h-auto justify-start whitespace-normal px-3 py-3 text-left",
                isActive && "ring-2 ring-primary ring-offset-1 ring-offset-surface",
              )}
              aria-pressed={isActive}
              onClick={() => onSelect(preset)}
            >
              <div className="flex w-full min-w-0 items-start gap-2.5">
                <span
                  className={cn(
                    "mt-0.5 shrink-0",
                    isActive ? "text-on-primary" : "text-on-surface-variant",
                  )}
                >
                  {getPresetIcon(preset.id)}
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div
                    className={cn(
                      "break-words font-medium",
                      isActive ? "text-on-primary" : "text-on-surface",
                    )}
                  >
                    {trDynamic(t, preset.name)}
                  </div>
                  <div
                    className={cn(
                      "break-words text-xs leading-relaxed",
                      isActive ? "text-on-primary/80" : "text-on-surface-variant",
                    )}
                  >
                    {trDynamic(t, preset.description)}
                  </div>
                </div>
                {isActive ? (
                  <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-on-primary" />
                ) : null}
              </div>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
