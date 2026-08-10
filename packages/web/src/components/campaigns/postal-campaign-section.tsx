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

import type { CustomFieldDefinition } from "@givernance/shared/custom-fields";
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
  /**
   * Epic #318 PR #4 — Swiss QR-bill discriminator passed through to the
   * postal-export panel so the mode-summary surface can render the
   * "Swiss QR-bill mode" badge + the right "this mode is selected
   * because…" explainer. Null when no bank account is linked (standard
   * mode).
   */
  bankAccount: { bankName: string | null; ibanLast4: string; currency: string } | null;
  initialMembers: CampaignMember[];
  initialMemberTotal: number;
  initialExports: PostalExport[];
  /**
   * Epic #539 §6 — projected donor definitions passed straight through to
   * the members card's column set. Empty ⇒ no custom columns.
   */
  donorCustomDefs?: CustomFieldDefinition[];
  /**
   * Whether `campaign.postal_merged_pdf` is enabled for this tenant
   * (project item #194221573). SSR-resolved in the campaign page server
   * component and passed straight through to the export panel, which hides
   * the ZIP/merged-PDF format selector when false.
   */
  mergedPdfEnabled: boolean;
}

export function PostalCampaignSection({
  campaignId,
  campaignType,
  campaignStatus,
  publicPageStatus,
  bankAccount,
  initialMembers,
  initialMemberTotal,
  initialExports,
  donorCustomDefs = [],
  mergedPdfEnabled,
}: PostalCampaignSectionProps) {
  const [memberCount, setMemberCount] = useState(initialMemberTotal);

  return (
    <>
      <CampaignMembersCard
        campaignId={campaignId}
        initialMembers={initialMembers}
        initialTotal={initialMemberTotal}
        donorCustomDefs={donorCustomDefs}
        doorDrop={campaignType === "door_drop"}
        onTotalChanged={setMemberCount}
      />
      <PostalExportPanel
        campaignId={campaignId}
        campaignType={campaignType}
        campaignStatus={campaignStatus}
        publicPageStatus={publicPageStatus}
        bankAccount={bankAccount}
        initialExports={initialExports}
        linkedConstituentCount={memberCount}
        mergedPdfEnabled={mergedPdfEnabled}
      />
    </>
  );
}
