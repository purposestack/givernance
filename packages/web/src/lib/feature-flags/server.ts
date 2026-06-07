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
const IMPERSONATION_REPLICATE_KEY = "admin.impersonation_replicate";
const FINANCE_DASHBOARD_KEY = "admin.finance_dashboard";
const POSTAL_MERGED_PDF_KEY = "campaign.postal_merged_pdf";

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
 * Returns `true` iff `admin.impersonation_replicate` is on for the
 * caller. Drives whether the Back Office impersonation list renders
 * the Replicate row-action (issue #428). Fail-closed on projection
 * errors — better to hide the button than render one that points
 * at an off feature.
 */
export async function isImpersonationReplicateEnabled(): Promise<boolean> {
  try {
    const api = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(api);
    return isFlagEnabled(flags, IMPERSONATION_REPLICATE_KEY);
  } catch {
    return false;
  }
}

/**
 * Returns `true` iff `admin.finance_dashboard` is on for the current
 * caller (Epic #434, issue #206). Gates:
 *   - The `/admin/finance` super-admin page (returns notFound() when off).
 *   - The "Finance plateforme" sidebar entry.
 * Fail-closed on projection errors — better to hide the dashboard
 * than render it pointing at a 404 backend.
 */
export async function isFinanceDashboardEnabled(): Promise<boolean> {
  try {
    const api = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(api);
    return isFlagEnabled(flags, FINANCE_DASHBOARD_KEY);
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
