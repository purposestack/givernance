"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TenantDetailTabsProps {
  overview: ReactNode;
  domains: ReactNode;
  users: ReactNode;
  audit: ReactNode;
}

export function TenantDetailTabs({ overview, domains, users, audit }: TenantDetailTabsProps) {
  const t = useTranslations("admin.tenants.detail.tabs");

  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">{t("overview")}</TabsTrigger>
        <TabsTrigger value="domains">{t("domains")}</TabsTrigger>
        <TabsTrigger value="users">{t("users")}</TabsTrigger>
        <TabsTrigger value="audit">{t("audit")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">{overview}</TabsContent>
      <TabsContent value="domains">{domains}</TabsContent>
      <TabsContent value="users">{users}</TabsContent>
      <TabsContent value="audit">{audit}</TabsContent>
    </Tabs>
  );
}
