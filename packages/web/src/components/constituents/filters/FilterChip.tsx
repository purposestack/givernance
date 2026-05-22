"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { type FilterCondition, generateConditionLabel } from "./filter-types";

export interface FilterChipProps {
  condition: FilterCondition;
  onRemove?: (id: string) => void;
  variant?: "default" | "compact";
  className?: string;
  children?: ReactNode;
}

/**
 * Visual representation of a single filter condition.
 * Displays the condition in a human-readable format with an optional remove button.
 */
export function FilterChip({
  condition,
  onRemove,
  variant = "default",
  className,
  children,
}: FilterChipProps) {
  const label = condition.label || generateConditionLabel(condition);
  const isCompact = variant === "compact";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border",
        "bg-surface-container-low border-outline-variant",
        "text-on-surface-variant",
        isCompact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
        className,
      )}
    >
      <span className="font-medium">{label}</span>
      {children}
      {onRemove ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRemove(condition.id)}
          className={cn(
            "ml-0.5 -mr-1 p-0 hover:bg-transparent",
            isCompact ? "h-4 w-4" : "h-5 w-5",
          )}
          aria-label="Remove filter"
        >
          <X size={isCompact ? 12 : 14} />
        </Button>
      ) : null}
    </div>
  );
}

interface FilterChipGroupProps {
  conditions: FilterCondition[];
  onRemove?: (id: string) => void;
  logic?: "AND" | "OR";
  variant?: "default" | "compact";
  className?: string;
  maxVisible?: number;
}

/**
 * Group of filter chips with logic operator display.
 * Can collapse to show a limited number with "+N more" indicator.
 */
export function FilterChipGroup({
  conditions,
  onRemove,
  logic = "AND",
  variant = "default",
  className,
  maxVisible,
}: FilterChipGroupProps) {
  const visibleConditions = maxVisible ? conditions.slice(0, maxVisible) : conditions;
  const hiddenCount = maxVisible ? Math.max(0, conditions.length - maxVisible) : 0;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {visibleConditions.map((condition, index) => (
        <div key={condition.id} className="flex items-center gap-2">
          <FilterChip condition={condition} onRemove={onRemove} variant={variant} />
          {index < visibleConditions.length - 1 && (
            <span className="text-xs font-medium uppercase text-on-surface-variant">
              {logic}
            </span>
          )}
        </div>
      ))}
      {hiddenCount > 0 && (
        <span className="text-sm text-on-surface-variant">+{hiddenCount} more</span>
      )}
    </div>
  );
}