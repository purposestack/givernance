// #440 — SegmentedPeriod
"use client";

import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string = string> {
  value: T;
  /** Already-translated label (e.g. "30 j", "YTD"). */
  label: string;
  /** Optional Material Symbols Outlined glyph (e.g. "date_range"). */
  icon?: string;
  /** Optional title attribute (already-translated). */
  title?: string;
}

export interface SegmentedPeriodProps<T extends string = string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  /** Already-translated aria-label for the radiogroup (e.g. "Période"). */
  ariaLabel: string;
  className?: string;
}

export function SegmentedPeriod<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedPeriodProps<T>) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusIndex = useCallback((idx: number) => {
    const next = buttonRefs.current[idx];
    if (next) next.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
      // WAI-ARIA Radio Group keyboard model: arrow keys move focus AND
      // change selection (single-select). Home/End jump to ends.
      const last = options.length - 1;
      let nextIdx: number | null = null;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          nextIdx = idx === last ? 0 : idx + 1;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          nextIdx = idx === 0 ? last : idx - 1;
          break;
        case "Home":
          nextIdx = 0;
          break;
        case "End":
          nextIdx = last;
          break;
        default:
          return;
      }
      event.preventDefault();
      if (nextIdx === null) return;
      const target = options[nextIdx];
      if (!target) return;
      onChange(target.value);
      focusIndex(nextIdx);
    },
    [options, onChange, focusIndex],
  );

  return (
    <div className={cn("segmented", className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, idx) => {
        const active = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA Radio Group composite-widget pattern — <input type="radio"> can't carry the pill-button styling/icon/keyboard handling; mirrors the dashboard mockup .segmented markup and Radix RadioGroup internals.
          <button
            key={option.value}
            ref={(el) => {
              buttonRefs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={active ? "active" : undefined}
            title={option.title}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, idx)}
          >
            {option.icon ? (
              <span className="material-symbols-outlined" aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
