/** Donations service — business logic for donation operations */

import type {
  CustomFieldPatch,
  CustomFieldValues,
  CustomValidator,
} from "@givernance/shared/custom-fields";
import {
  campaigns,
  constituents,
  donationAllocations,
  donations,
  funds,
  outboxEvents,
  receipts,
  tenants,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { applyCustomPatchInTx } from "../../lib/custom-field-values.js";
import { db, withTenantContext } from "../../lib/db.js";
import { ExchangeRateService } from "../finance/exchange-rate-service.js";

/** Thrown when allocation amounts don't sum to the donation total */
export class AllocationSumMismatchError extends Error {
  constructor(
    public readonly allocSum: number,
    public readonly donationAmount: number,
  ) {
    super(`Allocation sum (${allocSum}) does not equal donation amount (${donationAmount})`);
    this.name = "AllocationSumMismatchError";
  }
}

/**
 * Thrown when a referenced `campaignId` or `fundId` belongs to a different
 * tenant. Route layer maps this to 404 so a curious attacker cannot
 * distinguish "doesn't exist" from "exists in another tenant" (aligns with
 * ADR to be added under issue #56 — cross-tenant 404 vs 422 semantics).
 */
export class CrossTenantReferenceError extends Error {
  constructor(
    public readonly reference: "campaign" | "fund",
    public readonly id: string,
  ) {
    super(`${reference} ${id} not found in tenant`);
    this.name = "CrossTenantReferenceError";
  }
}

async function assertCampaignBelongsToOrg(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string | null | undefined,
): Promise<void> {
  if (!campaignId) return;
  const [row] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
  if (!row) throw new CrossTenantReferenceError("campaign", campaignId);
}

async function assertFundsBelongToOrg(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  allocations: { fundId: string }[] | undefined,
): Promise<void> {
  if (!allocations || allocations.length === 0) return;
  const ids = Array.from(new Set(allocations.map((a) => a.fundId)));
  const rows = await tx
    .select({ id: funds.id })
    .from(funds)
    .where(and(inArray(funds.id, ids), eq(funds.orgId, orgId)));
  const foundIds = new Set(rows.map((r) => r.id));
  const missing = ids.find((id) => !foundIds.has(id));
  if (missing) throw new CrossTenantReferenceError("fund", missing);
}

/**
 * Single source of truth for the donations sort whitelist (issue #218).
 * Both the route's TypeBox literal union AND the service's
 * defense-in-depth normalizer derive from this tuple — adding a 7th
 * field is now a one-line change here, not two-and-pray-they-stay-in-sync.
 */
export const DONATION_SORT_FIELDS = [
  "donatedAt",
  "amountCents",
  "paymentMethod",
  "donor",
  "campaign",
  "createdAt",
] as const;
export type DonationSortField = (typeof DONATION_SORT_FIELDS)[number];
export type DonationSortOrder = "asc" | "desc";

export interface ListDonationsQuery {
  page: number;
  perPage: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  constituentId?: string;
  campaignId?: string;
  receiptStatus?: "pending" | "generated" | "failed";
  sort?: string;
  order?: string;
}

/**
 * Defense-in-depth: the route-level TypeBox literal union
 * (`DONATION_SORT_FIELDS` in `donations/routes.ts`) already 400s unknown
 * `sort` values before the handler runs, so this fallback is unreachable
 * in production. We keep it because the route schema and this Set could
 * drift if someone widens the schema to `Type.String()` for ergonomics —
 * the fallback then becomes the safety net rather than the contract.
 */
function normalizeDonationSort(value: string | undefined): DonationSortField {
  if (value && DONATION_SORT_FIELDS.includes(value as DonationSortField)) {
    return value as DonationSortField;
  }
  return "donatedAt";
}

function normalizeDonationOrder(value: string | undefined): DonationSortOrder {
  return value === "asc" ? "asc" : "desc";
}

/**
 * Build the ORDER BY clause for `GET /donations`. Always tiebreaks with
 * `asc(donations.id)` so offset pagination is deterministic across pages
 * even when many rows share the same sort key.
 *
 * `paymentMethod`, `donor`, and `campaign` are all free-text and may be
 * NULL (campaign FK is nullable, donor row may be soft-deleted), so they
 * share two tweaks:
 * - `lower(...)` — case-insensitive, matches the `name` treatment in
 *   campaigns/funds/constituents so "Wire" / "wire" / "WIRE" group together.
 * - explicit `NULLS LAST` for both `asc` and `desc` — Postgres' default
 *   puts NULLs first under `asc` and last under `desc`. Users sorting by
 *   "campaign desc" or "donor asc" don't want a wall of empty cells before
 *   any non-null data; pinning NULLs to the bottom either way is the least
 *   surprising read of the column.
 *
 * `donor` and `campaign` reference columns from tables joined into
 * `listDonations` via LEFT JOIN — their order is determined by the joined
 * row, not by anything on `donations` itself.
 */
function buildDonationOrderBy(sort: DonationSortField, order: DonationSortOrder) {
  const dir = order === "asc" ? asc : desc;
  if (sort === "amountCents") return [dir(donations.amountCents), asc(donations.id)];
  if (sort === "paymentMethod") {
    // No `sql.raw` — `order` is a typed literal but switching between two
    // pre-built `sql` fragments keeps the safety obvious in review.
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    return [sql`lower(${donations.paymentMethod}) ${direction} NULLS LAST`, asc(donations.id)];
  }
  if (sort === "donor") {
    // Sort on the joined constituent row. Tuple is (firstName, lastName)
    // to match the cell display ("First Last") — same rationale as
    // `buildConstituentOrderBy` in constituents/service.ts.
    // `COLLATE "und-x-icu"` (ICU root locale) so accents collate next to
    // their base letter — the DB default sorts "Élise" after "Victor".
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    return [
      sql`lower(${constituents.firstName}) COLLATE "und-x-icu" ${direction} NULLS LAST`,
      sql`lower(${constituents.lastName}) COLLATE "und-x-icu" ${direction} NULLS LAST`,
      asc(donations.id),
    ];
  }
  if (sort === "campaign") {
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    return [sql`lower(${campaigns.name}) ${direction} NULLS LAST`, asc(donations.id)];
  }
  if (sort === "createdAt") return [dir(donations.createdAt), asc(donations.id)];
  return [dir(donations.donatedAt), asc(donations.id)];
}

export interface DonationInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  campaignId?: string;
  paymentMethod?: string;
  paymentRef?: string;
  donatedAt?: string;
  fiscalYear?: number;
  allocations?: { fundId: string; amountCents: number }[];
  /**
   * Pre-validated + merged custom blob (Epic #539). The ROUTE owns
   * validation via the customization value-service; the service persists
   * whatever it receives verbatim — never pass a raw client patch here.
   */
  custom?: CustomFieldValues;
}

export interface DonationUpdateInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  campaignId?: string | null;
  paymentMethod?: string | null;
  paymentRef?: string | null;
  donatedAt?: string;
  fiscalYear?: number | null;
  allocations?: { fundId: string; amountCents: number }[];
  /**
   * RAW `custom` merge-patch (Epic #539). Unlike the create path, the
   * update path validates + merges INSIDE the update transaction over the
   * FOR UPDATE-locked current blob — reading the blob route-side would let
   * concurrent patches silently drop each other's keys. `undefined` = no
   * change. Requires `customValidator` when set.
   */
  custom?: CustomFieldPatch;
  /** Validator built from the org's active donation catalog by the route. */
  customValidator?: CustomValidator | null;
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function loadDonationUpdateContext(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  donationId: string,
  constituentId: string,
) {
  // Sequential awaits, deliberately: a transaction runs on ONE pg client,
  // and the FOR UPDATE read below can block on a concurrent writer —
  // issuing the sibling selects concurrently (Promise.all) would queue
  // query() calls on the busy client, a pattern pg deprecates and pg@9
  // removes.
  //
  // FOR UPDATE: the `custom` merge-patch is read-modify-write, so a
  // concurrent update of the same donation must block until this tx
  // commits and then re-read the fresh blob — otherwise the two patches
  // silently drop each other's keys.
  const existing = await tx
    .select({ id: donations.id, custom: donations.custom })
    .from(donations)
    .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)))
    .for("update");
  const constituent = await tx
    .select({ id: constituents.id })
    .from(constituents)
    .where(and(eq(constituents.id, constituentId), eq(constituents.orgId, orgId)));
  const tenant = await tx
    .select({ baseCurrency: tenants.baseCurrency })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  return { existing: existing[0] ?? null, constituent: constituent[0] ?? null, tenant: tenant[0] };
}

async function replaceDonationAllocations(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  donationId: string,
  allocations: { fundId: string; amountCents: number }[] | undefined,
) {
  await tx
    .delete(donationAllocations)
    .where(
      and(eq(donationAllocations.donationId, donationId), eq(donationAllocations.orgId, orgId)),
    );

  if (!allocations || allocations.length === 0) {
    return;
  }

  await tx.insert(donationAllocations).values(
    allocations.map((allocation) => ({
      orgId,
      donationId,
      fundId: allocation.fundId,
      amountCents: allocation.amountCents,
    })),
  );
}

/** Build the SQL conditions for a list-donations query */
function listDonationsConditions(orgId: string, query: ListDonationsQuery) {
  const {
    search,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    constituentId,
    campaignId,
    receiptStatus,
  } = query;
  const conditions = [eq(donations.orgId, orgId)];

  if (search) {
    const pattern = `%${search}%`;
    // Subquery: constituents matching the term. Issue #430 — every
    // subselect on a tenant-scoped table carries an explicit
    // `eq(constituents.orgId, orgId)` so the subselect never silently
    // depends on RLS (and never returns 0 rows if the deploy ever
    // ships the wrong DB role).
    conditions.push(
      inArray(
        donations.constituentId,
        db
          .select({ id: constituents.id })
          .from(constituents)
          .where(
            and(
              eq(constituents.orgId, orgId),
              or(
                ilike(constituents.firstName, pattern),
                ilike(constituents.lastName, pattern),
                ilike(constituents.email, pattern),
              ),
            ),
          ),
      ),
    );
  }

  if (dateFrom) conditions.push(gte(donations.donatedAt, new Date(dateFrom)));
  if (dateTo) conditions.push(lte(donations.donatedAt, new Date(dateTo)));
  if (amountMin !== undefined) conditions.push(gte(donations.amountCents, amountMin));
  if (amountMax !== undefined) conditions.push(lte(donations.amountCents, amountMax));
  if (constituentId) conditions.push(eq(donations.constituentId, constituentId));
  if (campaignId) conditions.push(eq(donations.campaignId, campaignId));
  if (receiptStatus) {
    // Donations whose latest receipt has the requested status. Issue
    // #430 — explicit org filter on the subselect.
    conditions.push(
      inArray(
        donations.id,
        db
          .select({ id: receipts.donationId })
          .from(receipts)
          .where(and(eq(receipts.orgId, orgId), eq(receipts.status, receiptStatus))),
      ),
    );
  }

  return and(...conditions);
}

/**
 * Attach the latest receipt status per donation. Constituent + campaign
 * names already arrive from `listDonations`'s LEFT JOINs (so that they're
 * sortable). Receipts stay separate because they're 1:N (latest by
 * createdAt) and would multiply rows in the list query.
 */
async function attachLatestReceiptStatus<T extends { id: string }>(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  rows: T[],
  orgId: string,
) {
  const donationIds = rows.map((d) => d.id);
  const receiptRows = await tx
    .select({ donationId: receipts.donationId, status: receipts.status })
    .from(receipts)
    // Issue #430: explicit `eq(receipts.orgId, orgId)` so the lookup
    // never returns rows from another tenant if a donation_id were ever
    // collide-able.
    .where(and(eq(receipts.orgId, orgId), inArray(receipts.donationId, donationIds)))
    .orderBy(desc(receipts.createdAt));

  const receiptByDonationId = new Map<string, (typeof receiptRows)[number]["status"]>();
  for (const r of receiptRows) {
    if (!receiptByDonationId.has(r.donationId)) {
      receiptByDonationId.set(r.donationId, r.status);
    }
  }

  return rows.map((d) => ({
    ...d,
    receiptStatus: receiptByDonationId.get(d.id) ?? null,
  }));
}

/** List donations for an organization with pagination and filtering */
export async function listDonations(orgId: string, query: ListDonationsQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;
  const where = listDonationsConditions(orgId, query);
  const sort = normalizeDonationSort(query.sort);
  const order = normalizeDonationOrder(query.order);

  return withTenantContext(orgId, async (tx) => {
    // LEFT JOIN constituents + campaigns so the donor/campaign names are
    // available both for `ORDER BY` (server-side sort on the joined row,
    // not on the visible page slice) AND for the response cell display.
    // LEFT (not INNER) is intentional: constituent rows can be soft-deleted
    // and `donations.campaignId` is nullable, so a missing join row means
    // "anonymous" / "no campaign", not "exclude this donation".
    const [data, countResult] = await Promise.all([
      tx
        .select({
          ...getTableColumns(donations),
          _constituentFirstName: constituents.firstName,
          _constituentLastName: constituents.lastName,
          _constituentCustom: constituents.custom,
          _constituentDeletedAt: constituents.deletedAt,
          _campaignName: campaigns.name,
        })
        .from(donations)
        // Issue #430: the join clauses carry the explicit org predicate too —
        // a leaked cross-tenant constituent/campaign id must never enrich a row.
        .leftJoin(
          constituents,
          and(eq(donations.constituentId, constituents.id), eq(constituents.orgId, orgId)),
        )
        .leftJoin(
          campaigns,
          and(eq(donations.campaignId, campaigns.id), eq(campaigns.orgId, orgId)),
        )
        .where(where)
        .orderBy(...buildDonationOrderBy(sort, order))
        .limit(perPage)
        .offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(donations).where(where),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    const pagination: Pagination = {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    };

    if (data.length === 0) {
      return { data: [], pagination };
    }

    const shaped = data.map(
      ({
        _constituentFirstName,
        _constituentLastName,
        _constituentCustom,
        _constituentDeletedAt,
        _campaignName,
        ...d
      }) => ({
        ...d,
        constituent:
          _constituentFirstName !== null && _constituentLastName !== null
            ? { firstName: _constituentFirstName, lastName: _constituentLastName }
            : null,
        campaign: _campaignName !== null ? { name: _campaignName } : null,
        // Raw donor blob for the route's projection serializer. Soft-deleted
        // (erased) donors project nothing — Epic #539 §6.
        donorCustomRaw: _constituentDeletedAt === null ? (_constituentCustom ?? {}) : {},
      }),
    );

    const enriched = await attachLatestReceiptStatus(tx, shaped, orgId);
    return { data: enriched, pagination };
  });
}

/** Get a single donation by ID, including constituent info and allocations */
export async function getDonation(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [donation] = await tx
      .select()
      .from(donations)
      .where(and(eq(donations.id, id), eq(donations.orgId, orgId)));

    if (!donation) return null;

    // Issue #430 — explicit org filter on every sibling lookup even
    // though the parent donation is already verified for this orgId.
    const [constituent] = await tx
      .select({
        id: constituents.id,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
        email: constituents.email,
        custom: constituents.custom,
        deletedAt: constituents.deletedAt,
      })
      .from(constituents)
      .where(and(eq(constituents.id, donation.constituentId), eq(constituents.orgId, orgId)));

    const allocations = await tx
      .select({
        id: donationAllocations.id,
        fundId: donationAllocations.fundId,
        amountCents: donationAllocations.amountCents,
        fundName: funds.name,
      })
      .from(donationAllocations)
      .innerJoin(funds, and(eq(funds.id, donationAllocations.fundId), eq(funds.orgId, orgId)))
      .where(and(eq(donationAllocations.donationId, id), eq(donationAllocations.orgId, orgId)));

    if (!constituent) {
      return { ...donation, constituent: null, donorCustomRaw: {}, allocations };
    }

    const { custom: donorCustom, deletedAt: donorDeletedAt, ...constituentPublic } = constituent;
    return {
      ...donation,
      constituent: constituentPublic,
      // Soft-deleted (erased) donors project nothing — Epic #539 §6. The
      // route serializes this through the projectable-definitions filter.
      donorCustomRaw: donorDeletedAt === null ? (donorCustom ?? {}) : {},
      allocations,
    };
  });
}

/** Get the generated receipt for a donation */
export async function getReceiptByDonation(orgId: string, donationId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.donationId, donationId),
          eq(receipts.orgId, orgId),
          eq(receipts.status, "generated"),
        ),
      );

    return receipt ?? null;
  });
}

/** Create a donation with optional allocations, emitting DonationCreated event transactionally.
 *  Returns null if the constituent does not exist within the tenant context. */
export async function createDonation(orgId: string, userId: string, input: DonationInput) {
  if (input.allocations && input.allocations.length > 0) {
    const allocSum = input.allocations.reduce((sum, a) => sum + a.amountCents, 0);
    if (allocSum !== input.amountCents) {
      throw new AllocationSumMismatchError(allocSum, input.amountCents);
    }
  }

  return withTenantContext(orgId, async (tx) => {
    // Verify constituent belongs to this tenant (FK check alone doesn't enforce RLS)
    const [constituent, tenant] = await Promise.all([
      tx
        .select({ id: constituents.id })
        .from(constituents)
        .where(and(eq(constituents.id, input.constituentId), eq(constituents.orgId, orgId))),
      tx.select({ baseCurrency: tenants.baseCurrency }).from(tenants).where(eq(tenants.id, orgId)),
    ]);

    if (!constituent[0]) return null;

    // Cross-tenant FK enforcement — issue #56 Data #1/#2. A Tenant B campaign
    // or fund id would otherwise pass the schema-level FK (uuid existence)
    // without being rejected, binding a donation to another tenant's records.
    await assertCampaignBelongsToOrg(tx, orgId, input.campaignId);
    await assertFundsBelongToOrg(tx, orgId, input.allocations);
    const currency = (input.currency ?? "EUR").toUpperCase();
    const baseCurrency = (tenant[0]?.baseCurrency ?? "EUR").toUpperCase();
    const exchangeRateService = new ExchangeRateService({ dbClient: tx });
    const convertedAmount = await exchangeRateService.convertAmountCents(
      input.amountCents,
      currency,
      baseCurrency,
    );

    const [donation] = await tx
      .insert(donations)
      .values({
        orgId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency,
        exchangeRate: convertedAmount.exchangeRate.toFixed(8),
        amountBaseCents: convertedAmount.amountBaseCents,
        campaignId: input.campaignId,
        paymentMethod: input.paymentMethod,
        paymentRef: input.paymentRef,
        donatedAt: input.donatedAt ? new Date(input.donatedAt) : new Date(),
        fiscalYear: input.fiscalYear,
        ...(input.custom !== undefined ? { custom: input.custom } : {}),
      })
      .returning();

    // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns a row
    const donationId = donation!.id;

    if (input.allocations && input.allocations.length > 0) {
      await tx.insert(donationAllocations).values(
        input.allocations.map((a) => ({
          orgId,
          donationId,
          fundId: a.fundId,
          amountCents: a.amountCents,
        })),
      );
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.created",
      payload: {
        donationId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency,
        createdBy: userId,
      },
    });

    return donation;
  });
}

/** Update a donation and fully replace its allocations. */
export async function updateDonation(orgId: string, id: string, input: DonationUpdateInput) {
  if (input.allocations && input.allocations.length > 0) {
    const allocSum = input.allocations.reduce((sum, a) => sum + a.amountCents, 0);
    if (allocSum !== input.amountCents) {
      throw new AllocationSumMismatchError(allocSum, input.amountCents);
    }
  }

  return withTenantContext(orgId, async (tx) => {
    const { existing, constituent, tenant } = await loadDonationUpdateContext(
      tx,
      orgId,
      id,
      input.constituentId,
    );

    if (!existing || !constituent) {
      return null;
    }

    // Cross-tenant FK enforcement on update path too.
    await assertCampaignBelongsToOrg(tx, orgId, input.campaignId ?? null);
    await assertFundsBelongToOrg(tx, orgId, input.allocations);

    // Merge the `custom` patch over the FOR UPDATE-locked current blob —
    // inside the transaction, so concurrent patches serialise instead of
    // overwriting each other (same pattern as constituents).
    const customColumn = applyCustomPatchInTx(existing.custom, input.custom, input.customValidator);

    const currency = (input.currency ?? "EUR").toUpperCase();
    const baseCurrency = (tenant?.baseCurrency ?? "EUR").toUpperCase();
    const exchangeRateService = new ExchangeRateService({ dbClient: tx });
    const convertedAmount = await exchangeRateService.convertAmountCents(
      input.amountCents,
      currency,
      baseCurrency,
    );

    const [updated] = await tx
      .update(donations)
      .set({
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency,
        exchangeRate: convertedAmount.exchangeRate.toFixed(8),
        amountBaseCents: convertedAmount.amountBaseCents,
        campaignId: input.campaignId ?? null,
        paymentMethod: normalizeNullableString(input.paymentMethod) ?? null,
        paymentRef: normalizeNullableString(input.paymentRef) ?? null,
        donatedAt: input.donatedAt ? new Date(input.donatedAt) : undefined,
        fiscalYear: input.fiscalYear === undefined ? undefined : input.fiscalYear,
        // Merged in-transaction above. `undefined` leaves the column untouched.
        custom: customColumn,
        updatedAt: new Date(),
      })
      .where(and(eq(donations.id, id), eq(donations.orgId, orgId)))
      .returning();

    await replaceDonationAllocations(tx, orgId, id, input.allocations);

    return updated ?? null;
  });
}

/** Delete a donation. Related allocations and receipts are removed by FK cascade. */
export async function deleteDonation(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [deleted] = await tx
      .delete(donations)
      .where(and(eq(donations.id, id), eq(donations.orgId, orgId)))
      .returning();

    return deleted ?? null;
  });
}

/**
 * Result of `refundDonation`. Discriminated union so the route layer
 * can map each precondition failure to the right HTTP status without
 * inspecting strings (issue #199).
 */
export type RefundDonationResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "not_stripe" }
  | { kind: "already_refunded" }
  | { kind: "stripe_error"; message: string };

/**
 * Issue a Stripe refund against the original PaymentIntent of a donation
 * and roll back the platform fee with `refund_application_fee: true`. The
 * actual donation-row update + campaign fee decrement happens in the
 * `charge.refunded` webhook handler (worker) so the change is observed
 * exactly once whether the refund originated from our UI or from the
 * NPO's Stripe dashboard. This route ALSO marks the donation as
 * `refunded` immediately for snappy UI feedback — the webhook handler
 * is idempotent on already-refunded rows.
 *
 * @returns discriminated union the route layer maps to HTTP status.
 */
export async function refundDonation(
  orgId: string,
  donationId: string,
  refundsApi: {
    create: (params: {
      payment_intent: string;
      refund_application_fee?: boolean;
    }) => Promise<unknown>;
  },
): Promise<RefundDonationResult> {
  // Three-phase flow so we never hold a Postgres connection through a
  // network call to Stripe (PR #193 review, finding #2):
  //   1. Read-and-validate transaction (RLS-scoped, fast).
  //   2. Stripe API call OUTSIDE any DB transaction.
  //   3. Write-back transaction (RLS-scoped, fast).
  // Holding a tx open across the Stripe call would pin a connection for
  // the full latency of `refunds.create` (variable, can timeout). Under
  // a burst of concurrent refunds the pool drains and unrelated requests
  // start queuing.

  // Phase 1 — read state, decide whether to call Stripe.
  const validation = await withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: donations.id,
        status: donations.status,
        paymentMethod: donations.paymentMethod,
        paymentRef: donations.paymentRef,
      })
      .from(donations)
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));
    return row ?? null;
  });

  if (!validation) return { kind: "not_found" } as const;
  if (validation.status === "refunded") return { kind: "already_refunded" } as const;
  if (validation.paymentMethod !== "stripe" || !validation.paymentRef) {
    // Off-Stripe donations (cash, SEPA imported, check) need their own
    // refund mechanism — out of scope here; route returns 422.
    return { kind: "not_stripe" } as const;
  }
  const paymentRef = validation.paymentRef;

  // Phase 2 — Stripe call. NO DB transaction held during this network
  // request. `refund_application_fee: true` rolls back the 1.5%+30¢
  // platform fee to the connected account at the same time as refunding
  // the donor — donor experience: "I got my €50 back, no fee."
  try {
    await refundsApi.create({
      payment_intent: paymentRef,
      refund_application_fee: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe refund failed";
    return { kind: "stripe_error", message } as const;
  }

  // Phase 3 — persist the local state change. There's a tiny race window
  // between phase 2 and phase 3 where the `charge.refunded` webhook can
  // fire before we mark the row; both writers are idempotent on
  // `status === "refunded"` so the second one short-circuits cleanly.
  await withTenantContext(orgId, async (tx) => {
    await tx
      .update(donations)
      .set({ status: "refunded" })
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));

    // Emit the domain event from the API path too — mirrors what the
    // webhook handler does. Outbox is keyed on `(tenantId, type,
    // payload->>donationId)` only; if a duplicate emit happens, the
    // relay's at-least-once delivery + downstream idempotency handles it.
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.refunded",
      payload: {
        donationId,
        paymentRef,
        source: "donation_refund_route",
      },
    });
  });

  return { kind: "ok" } as const;
}
