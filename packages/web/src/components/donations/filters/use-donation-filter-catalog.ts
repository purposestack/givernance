"use client";

import { useEffect, useRef, useState } from "react";
import type { FilterField } from "@/components/constituents/filters/filter-types";
import { createClientApiClient } from "@/lib/api/client-browser";
import { fetchDonationFilterFields, mergeDonationFilterCatalog } from "./donation-filter-catalog";
import { donationFilterFields } from "./donation-filter-fields";

/**
 * Donations filter catalog for the list page: static mirror immediately,
 * enriched with the per-org entries (campaign / fund options, custom
 * fields) once fetched. Only a SUCCESSFUL fetch is cached — a failed
 * attempt (API mid-restart, transient network error) retries on the next
 * rising edge of `active` (builder re-opened / filter surface re-engaged)
 * instead of silently pinning the static catalog until a full page
 * reload. `active` is false with the flag off, so the endpoint (which
 * 404s when off) is never touched on flag-off renders.
 */
export function useDonationFilterCatalog(active: boolean): FilterField[] {
  const [catalog, setCatalog] = useState<FilterField[]>(donationFilterFields);
  const succeededRef = useRef(false);

  useEffect(() => {
    if (!active || succeededRef.current) return;
    let cancelled = false;
    void (async () => {
      const raw = await fetchDonationFilterFields(createClientApiClient());
      if (!cancelled && raw) {
        succeededRef.current = true;
        setCatalog(mergeDonationFilterCatalog(donationFilterFields, raw));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  return catalog;
}
