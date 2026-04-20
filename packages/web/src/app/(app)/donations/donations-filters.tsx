"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ChangeEvent } from "react";

import { FilterBar } from "@/components/shared/filter-bar";

interface DonationsFiltersProps {
  dateFrom: string;
  dateTo: string;
}

export function DonationsFilters({ dateFrom, dateTo }: DonationsFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("donations.filters");

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <FilterBar
      filters={
        <>
          <DateField
            label={t("dateFrom")}
            value={dateFrom}
            onChange={(e) => setParam("dateFrom", e.target.value)}
          />
          <DateField
            label={t("dateTo")}
            value={dateTo}
            onChange={(e) => setParam("dateTo", e.target.value)}
          />
        </>
      }
    />
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
      <span>{label}</span>
      <input
        type="date"
        value={value}
        onChange={onChange}
        className="h-8 rounded-[var(--radius-input)] border border-outline-variant bg-surface-container-lowest px-2 font-body text-sm text-on-surface focus-visible:border-primary focus-visible:outline-none focus-visible:shadow-ring"
      />
    </label>
  );
}
