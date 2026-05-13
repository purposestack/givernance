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
   * Feature-flags tab content. Phase 2 (Epic #365) addition. The
   * super-admin tenant detail page passes `null` when the
   * `admin.feature_flags_phase2` self-flag is off so the tab is
   * absent end-to-end (matches the off-state QA requirement that
   * the whole surface disappears, not just the tab body).
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
