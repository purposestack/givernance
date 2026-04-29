"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface StatCardTrendProps {
  /** Rounded percentage change between current and previous period. */
  value: number;
  /** Short label shown in the tooltip (e.g. "vs previous month"). */
  label: string;
  /** Formatted current and previous values displayed in the tooltip. */
  detail?: { current: string; previous: string };
}

export function StatCardTrend({ value, label, detail }: StatCardTrendProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`${value > 0 ? "+" : ""}${value}% — ${label}`}
          >
            <Badge
              variant={value >= 0 ? "success" : "error"}
              className="text-[10px] px-1.5 py-0 h-5"
            >
              {value > 0 ? "+" : ""}
              {value}%
            </Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs leading-relaxed">
          <p className="font-medium">{label}</p>
          {detail ? (
            <p className="mt-1 font-mono tabular-nums opacity-80">
              {detail.previous} → {detail.current}
            </p>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
