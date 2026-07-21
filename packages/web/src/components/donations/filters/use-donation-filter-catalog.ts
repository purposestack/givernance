"use client";

import { useEffect, useState } from "react";
import type { FilterField } from "@/components/constituents/filters/filter-types";
import { createClientApiClient } from "@/lib/api/client-browser";
import { fetchDonationFilterFields, mergeDonationFilterCatalog } from "./donation-filter-catalog";
import { donationFilterFields } from "./donation-filter-fields";

/**
 * Donations filter catalog for the list page: static mirror immediately,
 * enriched with the per-org entity options (campaign / fund pickers) once
 * fetched. The fetch fires at most once per mount and only when `active`
 * (flag on AND a filter surface is actually in play — an applied `?filters=`
 * or an opened builder), so flag-off renders never touch the endpoint
 * (which 404s when off).
 */
export function useDonationFilterCatalog(active: boolean): FilterField[] {
  const [catalog, setCatalog] = useState<FilterField[]>(donationFilterFields);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!active || attempted) return;
    setAttempted(true);
    let cancelled = false;
    void (async () => {
      const raw = await fetchDonationFilterFields(createClientApiClient());
      if (!cancelled && raw) {
        setCatalog(mergeDonationFilterCatalog(donationFilterFields, raw));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, attempted]);

  return catalog;
}
