"use client";

import { forwardRef, useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface AmountInputChangeMeta {
  isEmpty: boolean;
  isValid: boolean;
  raw: string;
}

export interface AmountInputProps {
  value: number | null | undefined;
  onChange: (value: number | null, meta: AmountInputChangeMeta) => void;
  placeholder?: string;
  className?: string;
  currencySymbol?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

interface ParsedAmount {
  isValid: boolean;
  value: number | null;
}

export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(function AmountInput(
  {
    value,
    onChange,
    placeholder,
    className,
    currencySymbol = "€",
    id,
    name,
    disabled,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
  },
  ref,
) {
  const [raw, setRaw] = useState<string>(() => centsToDisplay(value));
  const lastPropValueRef = useRef<number | null | undefined>(value);
  const rawRef = useRef(raw);

  useEffect(() => {
    rawRef.current = raw;
  }, [raw]);

  useEffect(() => {
    if (Object.is(value, lastPropValueRef.current)) return;
    lastPropValueRef.current = value;

    if (typeof value === "number" && Number.isNaN(value)) {
      return;
    }

    const parsedCurrentRaw = parseAmountInput(rawRef.current);
    if (parsedCurrentRaw.isValid && Object.is(parsedCurrentRaw.value, value ?? null)) {
      return;
    }

    setRaw(centsToDisplay(value));
  }, [value]);

  function propagate(nextRaw: string) {
    const parsed = parseAmountInput(nextRaw);
    onChange(parsed.value, {
      raw: nextRaw,
      isValid: parsed.isValid,
      isEmpty: parsed.value === null,
    });
    return parsed;
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-variant">
        {currencySymbol}
      </span>
      <Input
        ref={ref}
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        value={raw}
        disabled={disabled}
        placeholder={placeholder}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cn("pl-12 font-mono tabular-nums", className)}
        onChange={(event) => {
          const nextRaw = event.target.value;
          setRaw(nextRaw);
          propagate(nextRaw);
        }}
        onBlur={() => {
          const parsed = propagate(raw);
          if (parsed.isValid) {
            setRaw(centsToDisplay(parsed.value));
          }
        }}
      />
    </div>
  );
});

export function centsToDisplay(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return (value / 100).toFixed(2);
}

export function parseAmountInput(raw: string): ParsedAmount {
  const normalized = raw.trim().replace(/\s/g, "").replace(",", ".");

  if (normalized === "") {
    return { value: null, isValid: true };
  }

  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) {
    return { value: null, isValid: false };
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, isValid: false };
  }

  return { value: Math.round(parsed * 100), isValid: true };
}
