import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { SettingsNavFlagsProvider } from "@/components/settings/settings-nav-flags";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

/**
 * Settings layout — guarded by the application `org_admin` role.
 *
 * The whole `/settings/*` surface (organisation defaults, members,
 * funds, snapshot export) is admin-only: every page issues a request
 * to an `org_admin`-gated endpoint, and a non-admin landing on any of
 * them would crash the SSR render with a 403 from the API. Blocking
 * here is the right architectural layer.
 *
 * Non-admin users get a 404 (not a 403) so the surface is not
 * discoverable via authorisation-error probing — same rationale as
 * `(admin)/layout.tsx`. The sidebar / topbar entries that link here
 * are hidden client-side via `hasAppRole("org_admin")` to avoid
 * dead-end clicks; this guard is the durable enforcement.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  if (!auth.roles.includes("org_admin")) {
    notFound();
  }

  // Epic #539 — the "Custom fields" settings-nav entry only exists when at
  // least one of the three per-domain flags is on. Resolved once here (the
  // nav strip renders on every settings page); a flag-fetch failure means
  // the entry stays hidden — the safest posture.
  let customFieldsEnabled = false;
  try {
    const client = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(client);
    customFieldsEnabled =
      isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS) ||
      isFlagEnabled(flags, FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS) ||
      isFlagEnabled(flags, FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS);
  } catch {
    customFieldsEnabled = false;
  }

  return (
    <SettingsNavFlagsProvider customFieldsEnabled={customFieldsEnabled}>
      {children}
    </SettingsNavFlagsProvider>
  );
}
