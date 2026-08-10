/**
 * Server-side helpers for SSR-resolving tenant feature-flag state.
 *
 * The public projection (`/v1/feature-flags`) is the cheapest way to
 * decide whether a flag-gated surface should render. Fail-closed: if
 * the projection is unreachable, the caller treats the surface as off
 * rather than risk a dead-end render.
 */

import { createServerApiClient } from "@/lib/api/client-server";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

const PUBLIC_PAGE_STYLES_KEY = "donation.public_page_styles";
const POSTAL_MERGED_PDF_KEY = "campaign.postal_merged_pdf";
const MULTI_CURRENCY_KEY = "donation.multi_currency";

/**
 * Returns `true` iff `donation.public_page_styles` is on for the
 * caller's tenant (Epic #362). Drives whether the per-campaign style
 * selector renders inside the campaign public-page editor and
 * whether the public-page shell lazy-loads archetype slot bundles.
 * Fail-closed on projection errors — better to hide the picker than
 * render it pointing at a 404 backend.
 */
export async function isPublicPageStylesEnabled(): Promise<boolean> {
  try {
    const api = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(api);
    return isFlagEnabled(flags, PUBLIC_PAGE_STYLES_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns `true` iff `campaign.postal_merged_pdf` is on for the caller's
 * tenant (project item #194221573). Drives whether the postal-export
 * panel renders the ZIP/merged-PDF format selector. Fail-closed on
 * projection errors — better to hide the selector (export stays a ZIP)
 * than render an option the backend will reject.
 */
export async function isPostalMergedPdfEnabled(): Promise<boolean> {
  try {
    const api = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(api);
    return isFlagEnabled(flags, POSTAL_MERGED_PDF_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns `true` iff `donation.multi_currency` is on for the caller's tenant
 * (ADR-032, Epic #416). Drives whether the per-user display-currency picker
 * renders on the profile page. Fail-closed on projection errors — better to
 * hide the picker (the user follows the org base currency) than render a
 * net-new surface the feature-flag-first rule says must stay hidden when off.
 */
export async function isMultiCurrencyEnabled(): Promise<boolean> {
  try {
    const api = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(api);
    return isFlagEnabled(flags, MULTI_CURRENCY_KEY);
  } catch {
    return false;
  }
}
