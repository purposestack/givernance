"use client";

import { CircleHelp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface InfoTooltipButtonProps {
  /** Accessible name for the trigger (e.g. "Explain campaign cost breakdown"). */
  ariaLabel: string;
  /** Tooltip body text rendered on hover / focus. */
  content: string;
}

/**
 * Small "i" helper rendered next to a heading. Wraps Radix Tooltip in a
 * client component so it can be safely embedded inside an async Server
 * Component without triggering a hydration mismatch on the Radix-generated
 * `contentId` / `data-state` / event-handler attributes.
 */
export function InfoTooltipButton({ ariaLabel, content }: InfoTooltipButtonProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
            aria-label={ariaLabel}
          >
            <CircleHelp size={16} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 text-sm leading-relaxed">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
