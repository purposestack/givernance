/**
 * Legacy postal QR redirect (Epic #274).
 *
 * The first version of the worker emitted QR payloads under
 * `/c/:campaignId?qr=…`, but the public donation page actually lives at
 * `/p/:id`. New exports already use the right path, but printed letters
 * generated against the old build are baked in stone — donors scanning
 * one of those letters would land on a Next.js 404.
 *
 * This route is a **permanent server redirect** that preserves the full
 * search-string (notably `?qr=…`) so the QR-token attribution flow on
 * `/p/:id` still works for legacy postal letters. Once we're confident
 * no `/c/:id` letters remain in circulation (~1 year of print cycles),
 * we can remove this file.
 */

import { permanentRedirect } from "next/navigation";

interface LegacyCampaignRedirectProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LegacyCampaignRedirect({
  params,
  searchParams,
}: LegacyCampaignRedirectProps) {
  const { id } = await params;
  const sp = await searchParams;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) query.append(key, v);
    } else {
      query.set(key, value);
    }
  }
  const qs = query.toString();
  permanentRedirect(`/p/${id}${qs ? `?${qs}` : ""}`);
}
