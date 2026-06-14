"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TenantDetailTabsProps {
  overview: ReactNode;
  domains: ReactNode;
  users: ReactNode;
  audit: ReactNode;
  /**
   * Feature-flags tab content (Epic #365). The super-admin tenant
   * detail page passes `null` when the per-tenant flag fetch fails so
   * the tab degrades to absent rather than 500-ing the whole page.
   */
  featureFlags?: ReactNode | null;
}

export function TenantDetailTabs({
  overview,
  domains,
  users,
  audit,
  featureFlags,
}: TenantDetailTabsProps) {
  const t = useTranslations("admin.tenants.detail.tabs");

  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">{t("overview")}</TabsTrigger>
        <TabsTrigger value="domains">{t("domains")}</TabsTrigger>
        <TabsTrigger value="users">{t("users")}</TabsTrigger>
        <TabsTrigger value="audit">{t("audit")}</TabsTrigger>
        {featureFlags ? <TabsTrigger value="featureFlags">{t("featureFlags")}</TabsTrigger> : null}
      </TabsList>
      <TabsContent value="overview">{overview}</TabsContent>
      <TabsContent value="domains">{domains}</TabsContent>
      <TabsContent value="users">{users}</TabsContent>
      <TabsContent value="audit">{audit}</TabsContent>
      {featureFlags ? <TabsContent value="featureFlags">{featureFlags}</TabsContent> : null}
    </Tabs>
  );
}
