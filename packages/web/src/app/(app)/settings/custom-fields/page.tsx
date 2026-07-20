import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type {
  CustomFieldCatalog,
  CustomFieldDomain,
  CustomFieldUsageRow,
} from "@/models/custom-field";
import { CustomFieldsService } from "@/services/CustomFieldsService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

import { CustomFieldsManager } from "./custom-fields-manager";

export const dynamic = "force-dynamic";

/**
 * Custom-fields admin page (Epic #539). The settings layout already 404s
 * non-`org_admin` users; this page additionally 404s when none of the three
 * per-domain flags is on, and renders one tab per flag-enabled domain only
 * (off-state QA: a disabled domain leaves no trace).
 */
const DOMAIN_FLAGS: ReadonlyArray<{ domain: CustomFieldDomain; flagKey: string }> = [
  { domain: "constituent", flagKey: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS },
  { domain: "donation", flagKey: FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS },
  { domain: "campaign", flagKey: FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS },
];

const EMPTY_CATALOG: CustomFieldCatalog = {
  definitions: [],
  archived: [],
  quotas: null,
  catalogVersion: null,
};

interface CustomFieldsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CustomFieldsPage({ searchParams }: CustomFieldsPageProps) {
  const auth = await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("settings.customFields");
  const tSettings = await getTranslations("settings");
  const client = await createServerApiClient();

  let enabledDomains: CustomFieldDomain[] = [];
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    enabledDomains = DOMAIN_FLAGS.filter((entry) => isFlagEnabled(flags, entry.flagKey)).map(
      (entry) => entry.domain,
    );
  } catch {
    enabledDomains = [];
  }
  const firstEnabledDomain = enabledDomains[0];
  if (firstEnabledDomain === undefined) {
    notFound();
  }

  const rawDomain = Array.isArray(params.domain) ? params.domain[0] : params.domain;
  const activeDomain = enabledDomains.includes(rawDomain as CustomFieldDomain)
    ? (rawDomain as CustomFieldDomain)
    : firstEnabledDomain;

  // One catalog per enabled domain: the active tab needs the full catalog,
  // the other tabs only their field count. A failed fetch degrades to an
  // empty catalog rather than crashing the page.
  const catalogs = new Map<CustomFieldDomain, CustomFieldCatalog>();
  await Promise.all(
    enabledDomains.map(async (domain) => {
      try {
        catalogs.set(domain, await CustomFieldsService.getCatalog(client, domain));
      } catch {
        catalogs.set(domain, EMPTY_CATALOG);
      }
    }),
  );

  // Usage doubles as the quota source: the catalog GET carries no quota
  // block, so the meter degrades to a bare count if this fetch fails.
  let usage: CustomFieldUsageRow[] = [];
  let quotas: CustomFieldCatalog["quotas"] = null;
  try {
    const domainUsage = await CustomFieldsService.getUsage(client, activeDomain);
    usage = domainUsage.rows;
    quotas = domainUsage.quotas;
  } catch {
    usage = [];
  }

  const baseCatalog = catalogs.get(activeDomain) ?? EMPTY_CATALOG;
  const catalog = quotas ? { ...baseCatalog, quotas } : baseCatalog;
  const canManage = auth.roles.includes("org_admin");

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("title") },
        ]}
      />
      <SettingsNavigation />

      {/* ADR-035 rule A1 — header + sub-nav + domain tabs are static shell;
          the quota card / field table / archived section cascade inside the
          manager (rules A2/A3). */}
      <CustomFieldsManager
        key={`${activeDomain}:${catalog.catalogVersion ?? ""}`}
        domain={activeDomain}
        domainTabs={enabledDomains.map((domain) => ({
          domain,
          count: (catalogs.get(domain) ?? EMPTY_CATALOG).definitions.length,
        }))}
        catalog={catalog}
        usage={usage}
        canManage={canManage}
      />
    </>
  );
}
