"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface DetailTabsProps {
  overview: ReactNode;
  donations: ReactNode;
  timeline: ReactNode;
}

/**
 * Client-side Tabs wrapper for the constituent detail view.
 *
 * The server component renders the individual tab panels (including the
 * client-only DataTable for donations) and passes them in as children so the
 * server-rendered subtree is preserved across tab switches.
 */
export function DetailTabs({ overview, donations, timeline }: DetailTabsProps) {
  const t = useTranslations("constituentDetail.tabs");

  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">{t("overview")}</TabsTrigger>
        <TabsTrigger value="donations">{t("donations")}</TabsTrigger>
        <TabsTrigger value="timeline">{t("timeline")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">{overview}</TabsContent>
      <TabsContent value="donations">{donations}</TabsContent>
      <TabsContent value="timeline">{timeline}</TabsContent>
    </Tabs>
  );
}
