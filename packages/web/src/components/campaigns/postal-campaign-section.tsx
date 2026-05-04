"use client";

/**
 * Client-side wrapper that owns the "linked constituent count" state shared
 * between {@link CampaignMembersCard} and {@link PostalExportPanel} on the
 * campaign detail page (Epic #274).
 *
 * Without this wrapper the two cards lived as siblings under the
 * server-rendered campaign page: the members card mutated its local count
 * via `useState` on add/remove, but the export panel kept its initial
 * server-rendered `linkedConstituentCount` prop forever — leaving the
 * "Personalized" mode toggle locked on `disabled` even after the user
 * attached recipients in the same browser session.
 */

import { useState } from "react";

import { CampaignMembersCard } from "@/components/campaigns/campaign-members-card";
import { PostalExportPanel } from "@/components/campaigns/postal-export-panel";
import type { Campaign, CampaignType } from "@/models/campaign";

import type { CampaignMember, PostalExport } from "@/services/PostalCampaignService";

interface PostalCampaignSectionProps {
  campaignId: string;
  campaignType: CampaignType;
  /** Drives the "campaign must be active" readiness banner (Epic #274). */
  campaignStatus: Campaign["status"];
  /**
   * Drives the "publish your public donation page" readiness banner.
   * - `missing` — no `campaign_public_pages` row exists yet
   * - `draft`   — row exists but the donor-facing page returns 404
   * - `published` — donors can scan postal QR codes and donate
   */
  publicPageStatus: "missing" | "draft" | "published";
  initialMembers: CampaignMember[];
  initialMemberTotal: number;
  initialExports: PostalExport[];
}

export function PostalCampaignSection({
  campaignId,
  campaignType,
  campaignStatus,
  publicPageStatus,
  initialMembers,
  initialMemberTotal,
  initialExports,
}: PostalCampaignSectionProps) {
  const [memberCount, setMemberCount] = useState(initialMemberTotal);

  return (
    <>
      <CampaignMembersCard
        campaignId={campaignId}
        initialMembers={initialMembers}
        initialTotal={initialMemberTotal}
        doorDrop={campaignType === "door_drop"}
        onTotalChanged={setMemberCount}
      />
      <PostalExportPanel
        campaignId={campaignId}
        campaignType={campaignType}
        campaignStatus={campaignStatus}
        publicPageStatus={publicPageStatus}
        initialExports={initialExports}
        linkedConstituentCount={memberCount}
      />
    </>
  );
}
