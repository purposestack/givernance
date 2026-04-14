/** Job processor — generate campaign document PDFs with QR codes */

import type { GenerateCampaignDocumentsJob } from "@givernance/shared/jobs";
import {
  campaignDocuments,
  campaignQrCodes,
  campaigns,
  constituents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { uploadCampaignPdf } from "../lib/s3.js";
import { generateCampaignLetterPdf } from "../services/campaign-pdf.js";

type Tx = Parameters<Parameters<typeof withWorkerContext>[1]>[0];

/** Generate a single nominative document for one constituent within a campaign */
async function generateConstituentDocument(
  tx: Tx,
  orgId: string,
  campaignId: string,
  campaignName: string,
  constituent: { id: string; firstName: string; lastName: string; email: string | null },
): Promise<string> {
  const code = `${orgId}-${campaignId}-${constituent.id}`;

  await tx.insert(campaignQrCodes).values({
    orgId,
    campaignId,
    constituentId: constituent.id,
    code,
  });

  const pdfBuffer = await generateCampaignLetterPdf({
    campaignName,
    orgId,
    qrCode: code,
    constituent: {
      firstName: constituent.firstName,
      lastName: constituent.lastName,
      email: constituent.email,
    },
  });

  const [pendingDoc] = await tx
    .select()
    .from(campaignDocuments)
    .where(
      and(
        eq(campaignDocuments.campaignId, campaignId),
        eq(campaignDocuments.constituentId, constituent.id),
        eq(campaignDocuments.orgId, orgId),
        eq(campaignDocuments.status, "pending"),
      ),
    );

  const docId = pendingDoc?.id ?? constituent.id;
  const s3Path = await uploadCampaignPdf(orgId, campaignId, docId, pdfBuffer);

  if (pendingDoc) {
    await tx
      .update(campaignDocuments)
      .set({ s3Path, status: "generated", updatedAt: new Date() })
      .where(and(eq(campaignDocuments.id, pendingDoc.id), eq(campaignDocuments.orgId, orgId)));
  }

  return s3Path;
}

/** Process campaign document generation for a batch of constituents (or one door_drop) */
export async function processGenerateCampaignDocuments(
  job: Job<GenerateCampaignDocumentsJob["data"]>,
) {
  const { campaignId, orgId, constituentIds } = job.data;

  job.log(`Generating campaign documents for campaign ${campaignId} (org: ${orgId})`);

  return withWorkerContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found for org ${orgId}`);
    }

    if (campaign.type === "door_drop") {
      const code = `${orgId}-${campaignId}-generic`;

      await tx.insert(campaignQrCodes).values({
        orgId,
        campaignId,
        constituentId: null,
        code,
      });

      const pdfBuffer = await generateCampaignLetterPdf({
        campaignName: campaign.name,
        orgId,
        qrCode: code,
        constituent: null,
      });

      const [pendingDoc] = await tx
        .select()
        .from(campaignDocuments)
        .where(
          and(
            eq(campaignDocuments.campaignId, campaignId),
            eq(campaignDocuments.orgId, orgId),
            eq(campaignDocuments.status, "pending"),
          ),
        );

      const docId = pendingDoc?.id ?? campaignId;
      const s3Path = await uploadCampaignPdf(orgId, campaignId, docId, pdfBuffer);

      if (pendingDoc) {
        await tx
          .update(campaignDocuments)
          .set({ s3Path, status: "generated", updatedAt: new Date() })
          .where(and(eq(campaignDocuments.id, pendingDoc.id), eq(campaignDocuments.orgId, orgId)));
      }

      job.log(`Door-drop document generated and uploaded to ${s3Path}`);
      return { generated: 1 };
    }

    // Nominative / digital campaigns — fetch constituent data
    if (constituentIds.length === 0) {
      job.log("No constituents to process");
      return { generated: 0 };
    }

    const constituentRows = await tx
      .select({
        id: constituents.id,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
        email: constituents.email,
      })
      .from(constituents)
      .where(and(inArray(constituents.id, constituentIds), eq(constituents.orgId, orgId)));

    let generated = 0;

    for (const constituent of constituentRows) {
      const s3Path = await generateConstituentDocument(
        tx,
        orgId,
        campaignId,
        campaign.name,
        constituent,
      );
      generated++;
      job.log(`Document generated for constituent ${constituent.id} → ${s3Path}`);
    }

    job.log(`Campaign ${campaignId}: ${generated} documents generated`);
    return { generated };
  });
}
