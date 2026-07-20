"use client";

import { SlidersHorizontal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface DonationsFiltersButtonProps {
  dateFrom: string;
  dateTo: string;
}

/**
 * Compact date-range filter for the donations list — the constituents
 * grammar: a "More filters" button living IN the table's search row,
 * opening a dialog, instead of the previous full-width FilterBar block
 * that pushed the search down a whole row. Dates drive the same
 * `?dateFrom=&dateTo=` URL params (server-filtered, page reset on
 * change), so deep links and SSR behave exactly as before.
 */
export function DonationsFiltersButton({ dateFrom, dateTo }: DonationsFiltersButtonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("donations.filters");

  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);

  // Re-sync drafts when the dialog reopens with fresh URL-driven values.
  useEffect(() => {
    if (open) {
      setFrom(dateFrom);
      setTo(dateTo);
    }
  }, [open, dateFrom, dateTo]);

  const hasActiveFilters = Boolean(dateFrom || dateTo);

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextFrom) {
      params.set("dateFrom", nextFrom);
    } else {
      params.delete("dateFrom");
    }
    if (nextTo) {
      params.set("dateTo", nextTo);
    } else {
      params.delete("dateTo");
    }
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant={hasActiveFilters ? "primary" : "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        {t("moreLabel")}
        {hasActiveFilters ? <Badge variant="info">•</Badge> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-on-surface" htmlFor="donationsDateFrom">
                {t("dateFrom")}
              </label>
              <Input
                id="donationsDateFrom"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-on-surface" htmlFor="donationsDateTo">
                {t("dateTo")}
              </label>
              <Input
                id="donationsDateTo"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setFrom("");
                setTo("");
                apply("", "");
              }}
            >
              {t("clear")}
            </Button>
            <Button onClick={() => apply(from, to)}>{t("apply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
