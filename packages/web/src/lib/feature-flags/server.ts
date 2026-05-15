/**
 * Server-side helpers for SSR-resolving Phase-2 feature-flag state
 * (Epic #365 / PR #366).
 *
 * The public projection (`/v1/feature-flags`) is the cheapest way to
 * decide whether a given Phase-2 surface should render. Used by:
 *   - Settings sub-pages (decide whether `SettingsNavigation`
 *     surfaces the Feature flags entry).
 *   - The org-admin Feature flags page itself (SSR-gate via
 *     `notFound()` when the Epic is off).
 *   - The super-admin tenant detail page (decide whether the
 *     Feature flags tab is rendered).
 *
 * Fail-closed: if the projection is unreachable, the caller treats
 * the surface as off rather than risk a dead-end render.
 */

import { createServerApiClient } from "@/lib/api/client-server";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

const PHASE2_KEY = "admin.feature_flags_phase2";
const PUBLIC_PAGE_STYLES_KEY = "donation.public_page_styles";

/**
 * Returns `true` iff `admin.feature_flags_phase2` is on for the
 * current caller. Never throws — a failure to fetch the projection
 * is treated as "off" so the new surfaces stay invisible during a
 * partial outage rather than render in an ambiguous state.
 */
export async function isFeatureFlagsPhase2Enabled(): Promise<boolean> {
  try {
    const api = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(api);
    return isFlagEnabled(flags, PHASE2_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns `true` iff `donation.public_page_styles` is on for the
 * caller's tenant (Epic #362). Drives whether the "Donation page
 * style" picker renders in `/settings` and whether the per-campaign
 * style selector renders in the campaign editor. Fail-closed on
 * projection errors — better to hide the picker than render it
 * pointing at a 404 backend.
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
