"use client";

import { Search, X } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onClear?: () => void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, onClear, value, placeholder = "Search…", ...props }, ref) => {
    const hasValue = typeof value === "string" ? value.length > 0 : Boolean(value);
    return (
      <div className={cn("relative flex items-center", className)}>
        <Search
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 text-on-surface-variant opacity-60"
        />
        <input
          ref={ref}
          type="search"
          value={value}
          placeholder={placeholder}
          className={cn(
            "w-full h-[var(--input-height)] pl-9 pr-9",
            "bg-surface-container-lowest text-on-surface",
            "border border-outline-variant rounded-[var(--radius-input)]",
            "font-body text-base placeholder:text-text-muted",
            "transition-[border-color,box-shadow] duration-normal ease-out",
            "focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
          {...props}
        />
        {hasValue && onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            className={cn(
              "absolute right-2 flex h-6 w-6 items-center justify-center",
              "rounded-[var(--radius-sm)] text-on-surface-variant",
              "hover:bg-surface-container hover:text-on-surface",
              "focus-visible:outline-none focus-visible:shadow-ring",
            )}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
