/** Campaigns service — business logic for postal campaign operations */

import type {
  CustomFieldPatch,
  CustomFieldValues,
  CustomValidator,
} from "@givernance/shared/custom-fields";
import {
  bankAccounts,
  campaignDocuments,
  campaignFunds,
  campaignPublicPages,
  campaigns,
  donations,
  funds,
  type OutboxMetadata,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, asc, desc, eq, ilike, inArray, type SQL, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { applyCustomPatchInTx } from "../../lib/custom-field-values.js";
import { withTenantContext } from "../../lib/db.js";
import { buildOutboxMetadata } from "../../lib/trace-context.js";

/**
 * Single source of truth for the campaigns sort whitelist (issue #218).
 * Tuple drives both the route's TypeBox literal union and the service-
 * level `normalizeCampaignSort` fallback.
 */
export const CAMPAIGN_SORT_FIELDS = ["name", "type", "status", "progress", "createdAt"] as const;
export type CampaignSortField = (typeof CAMPAIGN_SORT_FIELDS)[number];
export type CampaignSortOrder = "asc" | "desc";

/**
 * Defense-in-depth — see `donations/service.ts` `normalizeDonationSort`
 * for the rationale. Route-level TypeBox literal derived from the same
 * tuple is the contract; this fallback only kicks in if validation is
 * loosened.
 */
function normalizeCampaignSort(value: string | undefined): CampaignSortField {
  if (value && CAMPAIGN_SORT_FIELDS.includes(value as CampaignSortField)) {
    return value as CampaignSortField;
  }
  return "createdAt";
}

function normalizeCampaignOrder(value: string | undefined): CampaignSortOrder {
  return value === "asc" ? "asc" : "desc";
}

/**
 * ORDER BY for `GET /campaigns`. `name` uses `lower(...)` for
 * case-insensitive sort. `progress` orders by the ratio of net raised
 * (cleared − refunded base cents) to the public-page goal. Campaigns
 * without a goal (or `goal = 0`) are sorted as **0%** rather than
 * NULLS LAST, so the sort matches the cell's display: a campaign that
 * reads "0%" sits next to the other 0%-funded campaigns under both
 * directions, not at the bottom of the table. Overfunded (raised >
 * goal) campaigns produce a ratio > 1 and correctly sort highest
 * under desc. Always tiebreaks with `asc(id)` so offset pagination
 * stays deterministic across pages with duplicate sort keys.
 *
 * `progress` references columns from a LEFT JOINed aggregate (`raisedCol`
 * passed in from `listCampaigns`); their values are determined by the
 * joined row, not by anything on `campaigns` itself.
 */
function buildCampaignOrderBy(
  sort: CampaignSortField,
  order: CampaignSortOrder,
  raisedCol: SQL.Aliased<number | null>,
) {
  const dir = order === "asc" ? asc : desc;
  if (sort === "name") return [dir(sql`lower(${campaigns.name})`), asc(campaigns.id)];
  if (sort === "type") return [dir(campaigns.type), asc(campaigns.id)];
  if (sort === "status") return [dir(campaigns.status), asc(campaigns.id)];
  if (sort === "progress") {
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    return [
      sql`(CASE
        WHEN ${campaignPublicPages.goalAmountCents} IS NULL OR ${campaignPublicPages.goalAmountCents} = 0 THEN 0
        ELSE COALESCE(${raisedCol}, 0)::float / ${campaignPublicPages.goalAmountCents}
      END) ${direction}`,
      asc(campaigns.id),
    ];
  }
  return [dir(campaigns.createdAt), asc(campaigns.id)];
}

export interface CreateCampaignInput {
  name: string;
  /** Free-form admin-side description (Epic #274 follow-up). Soft-cap 2000 chars. */
  description?: string | null;
  type: "nominative_postal" | "door_drop" | "digital";
  defaultCurrency?: "EUR" | "GBP" | "CHF";
  parentId?: string | null;
  operationalCostCents?: number | null;
  goalAmountCents?: number | null;
  fundIds?: string[];
  /**
   * Optional Swiss QR-bill bank-account link (Epic #318). NULL = no
   * QR-bill (standard letter only); set = Swiss QR-bill mode on. The
   * service enforces same-tenant ownership of the FK target before
   * persisting (404-on-cross-tenant per ADR-019). The bank account must
   * be active (not soft-deleted) at write time.
   */
  bankAccountId?: string | null;
  /**
   * Override the reference-type derivation. `auto` (default) lets the
   * worker pick QRR or SCOR based on `bank_accounts.iban_kind`. Ignored
   * when `bankAccountId IS NULL`.
   */
  qrReferenceMode?: "auto" | "qrr" | "scor";
  /**
   * Pre-validated + merged custom blob (Epic #539). The ROUTE owns
   * validation via the customization value-service; the service persists
   * whatever it receives verbatim — never pass a raw client patch here.
   */
  custom?: CustomFieldValues;
}

export interface UpdateCampaignInput {
  name?: string;
  description?: string | null;
  type?: "nominative_postal" | "door_drop" | "digital";
  defaultCurrency?: "EUR" | "GBP" | "CHF";
  status?: "draft" | "active" | "closed";
  parentId?: string | null;
  operationalCostCents?: number | null;
  goalAmountCents?: number | null;
  fundIds?: string[];
  bankAccountId?: string | null;
  qrReferenceMode?: "auto" | "qrr" | "scor";
  /**
   * RAW `custom` merge-patch (Epic #539). Unlike the create path, the
   * update path validates + merges INSIDE the update transaction over the
   * FOR UPDATE-locked current blob — reading the blob route-side would let
   * concurrent patches silently drop each other's keys. `undefined` = no
   * change. Requires `customValidator` when set.
   */
  custom?: CustomFieldPatch;
  /** Validator built from the org's active campaign catalog by the route. */
  customValidator?: CustomValidator | null;
}

export interface ListCampaignsQuery {
  page: number;
  perPage: number;
  search?: string;
  status?: "draft" | "active" | "closed";
  sort?: string;
  order?: string;
}

function campaignSelectFields() {
  return {
    id: campaigns.id,
    orgId: campaigns.orgId,
    name: campaigns.name,
    description: campaigns.description,
    type: campaigns.type,
    status: campaigns.status,
    defaultCurrency: campaigns.defaultCurrency,
    parentId: campaigns.parentId,
    operationalCostCents: campaigns.operationalCostCents,
    platformFeesCents: campaigns.platformFeesCents,
    goalAmountCents: campaignPublicPages.goalAmountCents,
    // Epic #318: Swiss QR-bill discriminator. `bankAccountId IS NOT
    // NULL` IS the "Swiss QR-bill mode on" signal — see ADR-027 and
    // docs/25 §3 decision #4.
    bankAccountId: campaigns.bankAccountId,
    qrReferenceMode: campaigns.qrReferenceMode,
    // RAW custom blob — the route strips it and re-emits only the
    // definition-filtered projection (Epic #539 anti-goal #5).
    custom: campaigns.custom,
    createdAt: campaigns.createdAt,
    updatedAt: campaigns.updatedAt,
  };
}

async function getCampaignById(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  id: string,
) {
  const [row] = await tx
    .select(campaignSelectFields())
    .from(campaigns)
    .leftJoin(campaignPublicPages, eq(campaignPublicPages.campaignId, campaigns.id))
    .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)));

  return row ?? null;
}

async function listEligibleFundsForCampaignTx(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
) {
  return tx
    .select({
      id: funds.id,
      orgId: funds.orgId,
      name: funds.name,
      description: funds.description,
      type: funds.type,
      createdAt: funds.createdAt,
      updatedAt: funds.updatedAt,
    })
    .from(campaignFunds)
    .innerJoin(funds, eq(funds.id, campaignFunds.fundId))
    .where(and(eq(campaignFunds.orgId, orgId), eq(campaignFunds.campaignId, campaignId)))
    .orderBy(sql`${funds.createdAt} DESC`);
}

async function syncCampaignFunds(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
  fundIds: string[],
) {
  const uniqueFundIds = Array.from(new Set(fundIds));

  if (uniqueFundIds.length > 0) {
    const existingFunds = await tx
      .select({ id: funds.id })
      .from(funds)
      .where(and(eq(funds.orgId, orgId), inArray(funds.id, uniqueFundIds)));

    if (existingFunds.length !== uniqueFundIds.length) {
      throw new CampaignValidationError("One or more funds were not found in this organization");
    }
  }

  await tx
    .delete(campaignFunds)
    .where(and(eq(campaignFunds.orgId, orgId), eq(campaignFunds.campaignId, campaignId)));

  if (uniqueFundIds.length === 0) {
    return;
  }

  await tx.insert(campaignFunds).values(
    uniqueFundIds.map((fundId) => ({
      orgId,
      campaignId,
      fundId,
    })),
  );
}

/**
 * Persist the campaign-level fundraising goal. Stored on
 * `campaign_public_pages.goalAmountCents` (cf. ADR-pending) so it can also
 * back the public page widget. When no public_pages row exists yet (the
 * org hasn't opened the public-page editor), bootstrap a draft row whose
 * title mirrors the campaign name — the org can override every other
 * field later from `/campaigns/[id]/public-page`.
 */
async function upsertCampaignGoal(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
  campaignName: string,
  goalAmountCents: number | null,
) {
  const [existing] = await tx
    .select({ id: campaignPublicPages.id })
    .from(campaignPublicPages)
    .where(eq(campaignPublicPages.campaignId, campaignId));

  if (existing) {
    await tx
      .update(campaignPublicPages)
      .set({ goalAmountCents, updatedAt: new Date() })
      .where(eq(campaignPublicPages.id, existing.id));
    return;
  }

  await tx.insert(campaignPublicPages).values({
    orgId,
    campaignId,
    title: campaignName,
    status: "draft",
    goalAmountCents,
  });
}

/** List campaigns for an organization with pagination */
export async function listCampaigns(orgId: string, query: ListCampaignsQuery) {
  const { page, perPage, search, status } = query;
  const offset = (page - 1) * perPage;
  const sort = normalizeCampaignSort(query.sort);
  const order = normalizeCampaignOrder(query.order);

  return withTenantContext(orgId, async (tx) => {
    const conditions = [eq(campaigns.orgId, orgId)];

    if (search) {
      conditions.push(ilike(campaigns.name, `%${search}%`));
    }

    if (status) {
      conditions.push(eq(campaigns.status, status));
    }

    const where = and(...conditions);

    // Aggregate subquery: net raised cents per campaign (cleared minus
    // refunded), mirrors the `getCampaignStats` formula. LEFT JOINed
    // below so campaigns without donations still appear with NULL —
    // `buildCampaignOrderBy`'s `progress` branch coalesces NULL → 0
    // before dividing by goal, so a campaign with a goal but no
    // donations sorts at 0% (last under desc, first under asc).
    const raisedSq = tx
      .select({
        campaignId: donations.campaignId,
        raisedCents: sql<number | null>`SUM(CASE
          WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
          WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
          ELSE 0
        END)`.as("raised_cents"),
      })
      .from(donations)
      .where(eq(donations.orgId, orgId))
      .groupBy(donations.campaignId)
      .as("raised");

    const [data, countResult] = await Promise.all([
      tx
        .select(campaignSelectFields())
        .from(campaigns)
        .leftJoin(campaignPublicPages, eq(campaignPublicPages.campaignId, campaigns.id))
        .leftJoin(raisedSq, eq(raisedSq.campaignId, campaigns.id))
        .where(where)
        .orderBy(...buildCampaignOrderBy(sort, order, raisedSq.raisedCents))
        .limit(perPage)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(campaigns).where(where),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    const pagination: Pagination = {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    };

    return { data, pagination };
  });
}

/** Custom error for campaign validation failures */
export class CampaignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignValidationError";
  }
}

/** Create a new campaign */
export async function createCampaign(
  orgId: string,
  input: CreateCampaignInput,
  userId?: string,
  request?: FastifyRequest,
) {
  // W3C trace-context → outbox metadata (issue #55); null outside an HTTP request.
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  return withTenantContext(orgId, async (tx) => {
    // Validate parentId if provided
    if (input.parentId) {
      const [parent] = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.id, input.parentId), eq(campaigns.orgId, orgId)));
      if (!parent) {
        throw new CampaignValidationError("Parent campaign not found in this organization");
      }
    }

    // Epic #318: Swiss QR-bill bank-account link at create time.
    if (input.bankAccountId) {
      await validateBankAccountLink(tx, orgId, input.bankAccountId);
    }

    const [campaign] = await tx
      .insert(campaigns)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        defaultCurrency: input.defaultCurrency ?? "EUR",
        parentId: input.parentId ?? null,
        operationalCostCents: input.operationalCostCents ?? null,
        bankAccountId: input.bankAccountId ?? null,
        qrReferenceMode: input.qrReferenceMode ?? "auto",
        ...(input.custom !== undefined ? { custom: input.custom } : {}),
      })
      .returning({ id: campaigns.id });

    // Self-parent is also prevented by DB constraint, but the insert above
    // cannot produce a self-parent since the ID is generated by the DB.

    if (input.fundIds !== undefined) {
      // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns one row
      await syncCampaignFunds(tx, orgId, campaign!.id, input.fundIds);
    }

    if (input.goalAmountCents !== undefined) {
      // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns one row
      await upsertCampaignGoal(tx, orgId, campaign!.id, input.name, input.goalAmountCents);
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.created",
      payload: {
        campaignId: campaign?.id,
        name: input.name,
        campaignType: input.type,
        createdBy: userId,
      },
      metadata,
    });

    // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns one row
    return getCampaignById(tx, orgId, campaign!.id);
  });
}

/** Get a single campaign by ID */
export async function getCampaign(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => getCampaignById(tx, orgId, id));
}

/**
 * Detect cycles in the campaign parent hierarchy using a recursive CTE.
 * Returns true if setting `campaignId.parentId = newParentId` would create a cycle.
 */
async function wouldCreateCycle(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
  newParentId: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM campaigns WHERE id = ${newParentId} AND org_id = ${orgId}
      UNION ALL
      SELECT c.id, c.parent_id
      FROM campaigns c
      INNER JOIN ancestors a ON c.id = a.parent_id
    )
    SELECT 1 AS has_cycle FROM ancestors WHERE id = ${campaignId} LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Validate a candidate `bank_account_id` belongs to the same tenant and
 * is still active (not soft-deleted). Throws `CampaignValidationError`
 * with the corresponding error code if not — same shape as the readiness
 * gates so the UI surfaces the right banner.
 *
 * Same-org isolation is double-enforced: the lookup runs under
 * `withTenantContext` (RLS — a cross-tenant id returns no rows), AND we
 * explicitly check `bankAccounts.orgId = orgId` so a misconfigured
 * tenant context still 404s instead of silently writing the FK.
 * (ADR-019.)
 */
async function validateBankAccountLink(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  bankAccountId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      id: bankAccounts.id,
      deletedAt: bankAccounts.deletedAt,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.orgId, orgId)));

  if (!row) {
    throw new CampaignValidationError(
      "swiss_qr_bill_bank_account_not_found: bank account does not exist in this organisation",
    );
  }
  if (row.deletedAt !== null) {
    throw new CampaignValidationError(
      "swiss_qr_bill_bank_account_deleted: bank account was soft-deleted; pick a different account or restore it before linking",
    );
  }
}

async function validateParentUpdate(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
  parentId: string,
) {
  if (parentId === campaignId) {
    throw new CampaignValidationError("A campaign cannot be its own parent");
  }

  const [parent] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, parentId), eq(campaigns.orgId, orgId)));

  if (!parent) {
    throw new CampaignValidationError("Parent campaign not found in this organization");
  }

  if (await wouldCreateCycle(tx, orgId, campaignId, parentId)) {
    throw new CampaignValidationError(
      "Setting this parent would create a cycle in the campaign hierarchy",
    );
  }
}

/** Update a campaign (partial update) */
export async function updateCampaign(
  orgId: string,
  id: string,
  input: UpdateCampaignInput,
  userId: string,
  request?: FastifyRequest,
) {
  // W3C trace-context → outbox metadata (issue #55); null outside an HTTP request.
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  return withTenantContext(orgId, async (tx) => {
    // FOR UPDATE: the `custom` merge-patch below is read-modify-write, so
    // a concurrent update of the same campaign must block until this tx
    // commits and then re-read the fresh blob — otherwise the two patches
    // silently drop each other's keys.
    const [existing] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)))
      .for("update");

    if (!existing) return null;

    // Merge the `custom` patch over the locked current blob — inside the
    // transaction, so concurrent patches serialise instead of overwriting
    // each other (same pattern as constituents/donations).
    const customColumn = applyCustomPatchInTx(existing.custom, input.custom, input.customValidator);

    // Validate parentId: must not be self, must exist, must belong to same org, must not create cycle
    if (input.parentId !== undefined && input.parentId !== null) {
      await validateParentUpdate(tx, orgId, id, input.parentId);
    }

    // Epic #318: Swiss QR-bill bank-account link. Validate same-org +
    // active before persisting. NULL = unlink (degrade to standard mode).
    if (input.bankAccountId !== undefined && input.bankAccountId !== null) {
      await validateBankAccountLink(tx, orgId, input.bankAccountId);
    }

    if (input.fundIds !== undefined) {
      await syncCampaignFunds(tx, orgId, id, input.fundIds);
    }

    if (input.goalAmountCents !== undefined) {
      await upsertCampaignGoal(tx, orgId, id, input.name ?? existing.name, input.goalAmountCents);
    }

    const [updated] = await tx
      .update(campaigns)
      .set({
        name: input.name,
        description: input.description,
        type: input.type,
        defaultCurrency: input.defaultCurrency,
        status: input.status,
        parentId: input.parentId,
        operationalCostCents: input.operationalCostCents,
        // Epic #318: presence of `bankAccountId` IS the Swiss QR-bill
        // mode switch. `undefined` = no change; `null` = unlink.
        bankAccountId: input.bankAccountId,
        qrReferenceMode: input.qrReferenceMode,
        // Merged in-transaction above. `undefined` leaves the column untouched.
        custom: customColumn,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)))
      .returning({ id: campaigns.id });

    // Custom values are unredactable PII — the event records only THAT
    // they changed, never the blob itself (docs/35 GDPR posture). The
    // validator is request plumbing, never event payload.
    const { custom: customChange, customValidator: _validator, ...loggableChanges } = input;
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.updated",
      payload: {
        campaignId: id,
        changes: {
          ...loggableChanges,
          ...(customChange !== undefined ? { customChanged: true } : {}),
        },
        updatedBy: userId,
      },
      metadata,
    });

    return updated ? getCampaignById(tx, orgId, updated.id) : null;
  });
}

/** Close (soft-delete) a campaign by setting status to 'closed' */
export async function closeCampaign(
  orgId: string,
  id: string,
  userId: string,
  request?: FastifyRequest,
) {
  // W3C trace-context → outbox metadata (issue #55); null outside an HTTP request.
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)));

    if (!existing) return null;

    const now = new Date();
    const [closed] = await tx
      .update(campaigns)
      .set({ status: "closed", updatedAt: now })
      .where(and(eq(campaigns.id, id), eq(campaigns.orgId, orgId)))
      .returning({ id: campaigns.id });

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.closed",
      payload: {
        campaignId: id,
        closedBy: userId,
      },
      metadata,
    });

    return closed ? getCampaignById(tx, orgId, closed.id) : null;
  });
}

/** Get campaign stats: total raised, donation count, unique donors */
export async function getCampaignStats(orgId: string, campaignId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [stats] = await tx
      .select({
        totalRaisedCents: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
            WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
            ELSE 0
          END
        ), 0)`,
        donationCount: sql<number>`COUNT(
          CASE WHEN ${donations.status} IN ('cleared', 'refunded') THEN 1 END
        )`,
        uniqueDonors: sql<number>`COUNT(DISTINCT
          CASE
            WHEN ${donations.status} IN ('cleared', 'refunded') THEN ${donations.constituentId}
          END
        )`,
      })
      .from(donations)
      .where(and(eq(donations.campaignId, campaignId), eq(donations.orgId, orgId)));

    return {
      campaignId,
      totalRaisedCents: Number(stats?.totalRaisedCents ?? 0),
      donationCount: Number(stats?.donationCount ?? 0),
      uniqueDonors: Number(stats?.uniqueDonors ?? 0),
    };
  });
}

/** Get campaign ROI read-model — computed at read time from cleared/refunded donations only. */
export async function getCampaignRoi(orgId: string, campaignId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({
        id: campaigns.id,
        operationalCostCents: campaigns.operationalCostCents,
        platformFeesCents: campaigns.platformFeesCents,
        goalAmountCents: campaignPublicPages.goalAmountCents,
      })
      .from(campaigns)
      .leftJoin(campaignPublicPages, eq(campaignPublicPages.campaignId, campaigns.id))
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [stats] = await tx
      .select({
        rawRaisedCents: sql<number>`COALESCE(SUM(
          CASE
            WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
            WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
            ELSE 0
          END
        ), 0)`,
      })
      .from(donations)
      .where(and(eq(donations.campaignId, campaignId), eq(donations.orgId, orgId)));

    const rawRaisedCents = Number(stats?.rawRaisedCents ?? 0);
    const rawOperationalCostCents = campaign.operationalCostCents ?? null;
    const rawPlatformFeesCents = Number(campaign.platformFeesCents ?? 0);
    const totalCostCents = Number(rawOperationalCostCents ?? 0) + rawPlatformFeesCents;
    const roiPct =
      totalCostCents > 0 ? ((rawRaisedCents - totalCostCents) / totalCostCents) * 100 : null;

    return {
      campaignId,
      rawGoalCents: campaign.goalAmountCents ?? null,
      rawRaisedCents,
      rawPlatformFeesCents,
      rawOperationalCostCents,
      totalCostCents,
      roiPct,
    };
  });
}

/** Get the eligible funds linked to a campaign. Returns null when the campaign is missing. */
export async function listCampaignFunds(orgId: string, campaignId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) {
      return null;
    }

    return listEligibleFundsForCampaignTx(tx, orgId, campaignId);
  });
}

/** Request document generation for a campaign — emits CampaignDocumentsRequested event transactionally */
export async function requestCampaignDocuments(
  orgId: string,
  userId: string,
  campaignId: string,
  constituentIds: string[],
  request?: FastifyRequest,
) {
  // W3C trace-context → outbox metadata (issue #55); null outside an HTTP request.
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  return withTenantContext(orgId, async (tx) => {
    // Verify campaign exists and belongs to this org
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    // For door_drop, constituentIds is expected to be empty
    const ids = campaign.type === "door_drop" ? [] : constituentIds;

    // Create placeholder document records
    if (campaign.type === "door_drop") {
      await tx.insert(campaignDocuments).values({
        orgId,
        campaignId,
        constituentId: null,
        s3Path: "pending",
        status: "pending",
      });
    } else {
      if (ids.length > 0) {
        await tx.insert(campaignDocuments).values(
          ids.map((cId) => ({
            orgId,
            campaignId,
            constituentId: cId,
            s3Path: "pending",
            status: "pending" as const,
          })),
        );
      }
    }

    // Emit domain event in the same transaction
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.documents_requested",
      payload: {
        campaignId,
        constituentIds: ids,
        campaignType: campaign.type,
        requestedBy: userId,
      },
      metadata,
    });

    return { campaignId, documentCount: campaign.type === "door_drop" ? 1 : ids.length };
  });
}
