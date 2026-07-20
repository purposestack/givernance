/** Constituent service — business logic for constituent operations */

import {
  campaignConstituents,
  constituents,
  donations,
  mergeHistory,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import {
  and,
  arrayOverlaps,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gte,
  ilike,
  isNull,
  lte,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import { donationStatsJoin, FilterService } from "./filters/filter.service.js";
import type { FilterQuery } from "./filters/types.js";

/**
 * Single source of truth for the constituents sort whitelist (issue
 * #218). Tuple drives both the route's TypeBox literal union and the
 * service-level `normalizeConstituentSort` fallback.
 *
 * `lastDonation` (issue #215, mockup compliance) sorts on the joined
 * aggregate `MAX(donations.donatedAt)` from `latestDonationSubquery`
 * below — see `listConstituents` for the LEFT JOIN.
 */
export const CONSTITUENT_SORT_FIELDS = [
  "name",
  "type",
  "email",
  "lastDonation",
  "createdAt",
] as const;
export type ConstituentSortField = (typeof CONSTITUENT_SORT_FIELDS)[number];
export type ConstituentSortOrder = "asc" | "desc";

export interface ListConstituentsQuery {
  page: number;
  perPage: number;
  search?: string;
  tags?: string[];
  /** Legacy single-value filter — matches constituents whose `types` array contains it. */
  type?: string;
  /** Multi-value filter (issue #465) — matches constituents whose `types` overlap any of these. */
  types?: string[];
  includeDeleted?: boolean;
  sort?: string;
  order?: string;
  // ── Epic #274 filters ───────────────────────────────────────────────
  /** Restrict to constituents linked to this campaign (campaign_constituents). */
  campaignId?: string;
  /**
   * EXCLUDE constituents already linked to this campaign — used by the
   * "Add constituents" dialog so the picker only offers people not yet on
   * the mailing list. Opposite of `campaignId`.
   */
  excludeCampaignId?: string;
  /** Inclusive lower bound on `MAX(donations.donatedAt)`. ISO-8601 date string. */
  lastDonationFrom?: string;
  /** Inclusive upper bound on `MAX(donations.donatedAt)`. ISO-8601 date string. */
  lastDonationTo?: string;
  /** Inclusive lower bound on lifetime cleared-minus-refunded base cents. */
  minLifetimeAmountCents?: number;
  /** Inclusive upper bound on lifetime cleared-minus-refunded base cents. */
  maxLifetimeAmountCents?: number;
  /**
   * Advanced-filter DSL (Epic #418 / ADR-033) — the same `FilterQuery` shape
   * the FilterBuilder posts to `/v1/constituents/filter`. Compiled via
   * `FilterService.buildCompleteWhereClause` and AND-ed with every other
   * list predicate, so quick search / type chips / advanced filter compose.
   * The route MUST validate it (`FilterService.validateQuery`) and gate it on
   * the `advanced_filters` flag before it reaches this service.
   */
  advancedFilter?: FilterQuery;
}

/**
 * Defense-in-depth — see `donations/service.ts` `normalizeDonationSort`
 * for the rationale. Route-level TypeBox literal union
 * (`CONSTITUENT_SORT_FIELDS` in `routes.ts`) is the contract; this
 * fallback only kicks in if validation is loosened.
 */
function normalizeConstituentSort(value: string | undefined): ConstituentSortField {
  if (value && CONSTITUENT_SORT_FIELDS.includes(value as ConstituentSortField)) {
    return value as ConstituentSortField;
  }
  return "createdAt";
}

function normalizeConstituentOrder(value: string | undefined): ConstituentSortOrder {
  return value === "asc" ? "asc" : "desc";
}

/**
 * ORDER BY for `GET /constituents`. `name` sorts on `(firstName, lastName)`
 * to match the cell's display order (`fullName()` renders "First Last") —
 * sorting on the second-rendered token feels arbitrary to the user.
 * `lastDonation` sorts on the joined aggregate `MAX(donations.donatedAt)`
 * passed from the caller (NULLS LAST so never-donated constituents don't
 * form a wall under desc — same convention as `paymentMethod` /
 * `donor` / `campaign` in donations/service.ts).
 * `lower(...)` keeps mixed French/English locales in one alphabet. Always
 * tiebreaks with `asc(id)` for deterministic offset pagination.
 */
function buildConstituentOrderBy(
  sort: ConstituentSortField,
  order: ConstituentSortOrder,
  lastDonationAtCol: SQL.Aliased<string | null>,
) {
  const dir = order === "asc" ? asc : desc;
  if (sort === "name") {
    // `COLLATE "und-x-icu"` (ICU root locale) so accents collate next to their
    // base letter — the DB's default collation sorts "Élise" after the whole
    // ASCII alphabet (after "Victor"), which reads as broken.
    return [
      dir(sql`lower(${constituents.firstName}) COLLATE "und-x-icu"`),
      dir(sql`lower(${constituents.lastName}) COLLATE "und-x-icu"`),
      asc(constituents.id),
    ];
  }
  // Issue #465 — `type` is now the `types` array. Sort on its first element
  // (Postgres arrays are 1-indexed) so the column keeps a stable, intuitive
  // ordering; the first type is also what the single-badge spots render.
  if (sort === "type") return [dir(sql`${constituents.types}[1]`), asc(constituents.id)];
  if (sort === "email") {
    // Case-insensitive + NULLS LAST: not every constituent has an email
    // (volunteers contacted only by phone, anonymized records). Pinning
    // NULLs to the bottom under both directions matches the convention
    // used by `paymentMethod` / `donor` / `campaign`.
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    return [sql`lower(${constituents.email}) ${direction} NULLS LAST`, asc(constituents.id)];
  }
  if (sort === "lastDonation") {
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    return [sql`${lastDonationAtCol} ${direction} NULLS LAST`, asc(constituents.id)];
  }
  return [dir(constituents.createdAt), asc(constituents.id)];
}

export interface ConstituentInput {
  firstName: string;
  lastName: string;
  // `null` on update = explicit clear (drizzle's `.set({email: null})`
  // generates `SET email = NULL`). `undefined` = leave alone. The route
  // boundary accepts both per the convention in
  // `packages/shared/src/validators/index.ts` (ConstituentUpdateSchema).
  email?: string | null;
  phone?: string | null;
  // Postal address (Epic #274 follow-up). Drives the window-envelope
  // recipient block on personalised postal letters.
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
  // Canonical multi-valued type (issue #465). When present, the legacy
  // singular `type` is derived from `types[0]`. When omitted on UPDATE the
  // existing types are left untouched.
  types?: string[];
  // Legacy single-value type — accepted for back-compat (Salesforce ETL,
  // older clients). Coerced into `types` when `types` is omitted.
  type?: string;
  tags?: string[];
}

/**
 * Reconcile the legacy singular `type` with the canonical `types` array
 * (issue #465). Returns the DB column patch to merge into an INSERT/UPDATE:
 *   - `types` provided  → use it; mirror `type = types[0]`.
 *   - only `type`       → `types = [type]`; `type` stays as the shadow.
 *   - neither           → `{}` (leave both columns untouched on UPDATE; the
 *                          DB default `'{donor}'` + column default apply on
 *                          INSERT).
 * The singular `type` column is kept in lockstep as a back-compat shadow so
 * an un-migrated reader never breaks during the rollout window.
 */
function reconcileTypeColumns(input: {
  types?: string[];
  type?: string;
}): { types: string[]; type: string } | Record<string, never> {
  if (input.types && input.types.length > 0) {
    // De-dupe defensively — the validator enforces uniqueItems, but the ETL
    // / bulk-import paths build the array themselves.
    const types = Array.from(new Set(input.types));
    const first = types[0];
    if (first !== undefined) return { types, type: first };
  }
  if (input.type) {
    return { types: [input.type], type: input.type };
  }
  return {};
}

/**
 * Builds the WHERE conditions for `listConstituents` from the query params
 * (search / tags / type / campaignId / lastDonationFrom-To /
 * minLifetime-Max / includeDeleted). Pulled out of `listConstituents` to
 * keep that function under the cognitive-complexity threshold (extract-only,
 * behavior unchanged). The caller wraps the returned array in `and(...)`.
 *
 * Aggregate columns are passed in directly (instead of the whole subquery)
 * so the helper isn't coupled to drizzle's internal subquery shape.
 */
function buildListConstituentsWhere(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  query: ListConstituentsQuery,
  lastDonationAtColumn: SQL.Aliased<string | null>,
  lifetimeAmountCentsColumn: SQL.Aliased<number | null>,
): SQL[] {
  const {
    search,
    tags,
    type,
    types,
    includeDeleted,
    campaignId,
    excludeCampaignId,
    lastDonationFrom,
    lastDonationTo,
    minLifetimeAmountCents,
    maxLifetimeAmountCents,
  } = query;
  const conditions: SQL[] = [eq(constituents.orgId, orgId)];

  if (!includeDeleted) {
    conditions.push(isNull(constituents.deletedAt));
  }

  if (search) {
    // Split on whitespace + drop empties so "John " (trailing space) and
    // "John Doe" both behave intuitively. Single-token search keeps its
    // legacy shape (one OR across firstName / lastName / email). Multi-
    // token search AND-s the per-token ORs: each token must hit
    // somewhere, which is what makes "John Doe" return the row whose
    // first_name=John AND last_name=Doe even though no single column
    // contains "John Doe" literally. Previously this returned 0 rows.
    const tokens = search.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const pattern = `%${token}%`;
      const tokenCondition = or(
        ilike(constituents.firstName, pattern),
        ilike(constituents.lastName, pattern),
        ilike(constituents.email, pattern),
      );
      if (tokenCondition) {
        conditions.push(tokenCondition);
      }
    }
  }

  // Issue #465 — type filtering now targets the `types` array. Both the
  // multi-value `types` param and the legacy single `type` param compile to
  // an array-overlap (`types && ARRAY[...]`), index-backed by the GIN index.
  // A constituent matches if ANY of its types is in the requested set.
  const typeFilter = types && types.length > 0 ? types : type ? [type] : undefined;
  if (typeFilter) {
    conditions.push(arrayOverlaps(constituents.types, typeFilter));
  }

  if (tags && tags.length > 0) {
    // Drizzle's `arrayOverlaps` compiles to `col && ARRAY[...]::text[]` with
    // every tag bound as a proper parameter — no SQL interpolation of
    // user-supplied strings. Replaces the old `sql.raw` + manual `''` escape
    // (issue #56 Security #7).
    conditions.push(arrayOverlaps(constituents.tags, tags));
  }

  // Epic #274 — campaign membership filter via EXISTS subquery against
  // campaign_constituents. Avoids a join that would multiply rows when a
  // constituent is in multiple campaigns.
  if (campaignId) {
    conditions.push(
      exists(
        tx
          .select({ one: sql`1` })
          .from(campaignConstituents)
          .where(
            and(
              eq(campaignConstituents.constituentId, constituents.id),
              eq(campaignConstituents.campaignId, campaignId),
              eq(campaignConstituents.orgId, orgId),
            ),
          ),
      ),
    );
  }

  // Inverse of the above — exclude constituents already on a campaign's
  // mailing list (the "Add constituents" picker). NOT EXISTS so a person in
  // several campaigns is still offered for the ones they're not yet in.
  if (excludeCampaignId) {
    conditions.push(
      notExists(
        tx
          .select({ one: sql`1` })
          .from(campaignConstituents)
          .where(
            and(
              eq(campaignConstituents.constituentId, constituents.id),
              eq(campaignConstituents.campaignId, excludeCampaignId),
              eq(campaignConstituents.orgId, orgId),
            ),
          ),
      ),
    );
  }

  if (lastDonationFrom) {
    conditions.push(gte(lastDonationAtColumn, lastDonationFrom));
  }
  if (lastDonationTo) {
    conditions.push(lte(lastDonationAtColumn, lastDonationTo));
  }
  // Lifetime-amount filters: COALESCE the aggregate to 0 so constituents
  // with NO donation history (no row in `donation_agg` → NULL after the
  // LEFT JOIN) are still evaluated correctly. Without this, `gte(NULL, 0)`
  // evaluates to NULL in SQL (falsy in WHERE), so a filter of
  // `minLifetimeAmountCents=0` would silently exclude every zero-donor —
  // exactly the population an operator filtering "give me everyone with
  // ≥0 €" expects to see.
  if (minLifetimeAmountCents !== undefined) {
    conditions.push(
      gte(sql<number>`COALESCE(${lifetimeAmountCentsColumn}, 0)`, minLifetimeAmountCents),
    );
  }
  if (maxLifetimeAmountCents !== undefined) {
    conditions.push(
      lte(sql<number>`COALESCE(${lifetimeAmountCentsColumn}, 0)`, maxLifetimeAmountCents),
    );
  }

  return conditions;
}

/** List constituents for an organization with pagination, search, and filtering */
export async function listConstituents(orgId: string, query: ListConstituentsQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    // Aggregate subquery: latest donation date per constituent within
    // this tenant. LEFT JOINed below so constituents who never donated
    // appear with `lastDonationAt = NULL`. Pre-aggregating in a subquery
    // (vs. correlated scalar subquery in SELECT + ORDER BY) lets PG plan
    // a single hash aggregate over `donations` instead of one indexed
    // lookup per page row, and reuses the same value in SELECT and
    // ORDER BY without recomputation. Issue #215.
    //
    // Epic #274 extends this aggregate with `lifetimeAmountCents` so the
    // same join can serve `minLifetimeAmountCents` / `maxLifetimeAmountCents`
    // filters without a second pass over donations. Cleared minus refunded
    // mirrors the campaign-stats convention.
    const donationAggregate = tx
      .select({
        constituentId: donations.constituentId,
        lastDonationAt: sql<string | null>`max(${donations.donatedAt})`.as("last_donation_at"),
        lifetimeAmountCents: sql<number | null>`COALESCE(SUM(CASE
          WHEN ${donations.status} = 'cleared' THEN ${donations.amountBaseCents}
          WHEN ${donations.status} = 'refunded' THEN -${donations.amountBaseCents}
          ELSE 0
        END), 0)::int`.as("lifetime_amount_cents"),
      })
      .from(donations)
      .where(eq(donations.orgId, orgId))
      .groupBy(donations.constituentId)
      .as("donation_agg");

    // Advanced-filter DSL (Epic #418): compile the validated FilterQuery to a
    // where-clause and AND it with the regular list predicates. Aggregate
    // conditions (donations.totalAmount, donations.count, …) reference the
    // `donation_stats` alias, so the matching join is added — only when a DSL
    // filter is actually present, to keep the default list plan untouched.
    // `donation_agg` and `donation_stats` project disjoint column names, so
    // the two subquery joins coexist without ambiguity.
    const advancedWhere = query.advancedFilter
      ? new FilterService(orgId).buildCompleteWhereClause(query.advancedFilter)
      : undefined;

    const where = and(
      ...buildListConstituentsWhere(
        tx,
        orgId,
        query,
        donationAggregate.lastDonationAt,
        donationAggregate.lifetimeAmountCents,
      ),
      advancedWhere,
    );
    const sort = normalizeConstituentSort(query.sort);
    const order = normalizeConstituentOrder(query.order);

    let dataQuery = tx
      .select({
        ...getTableColumns(constituents),
        lastDonationAt: donationAggregate.lastDonationAt,
      })
      .from(constituents)
      .leftJoin(donationAggregate, eq(donationAggregate.constituentId, constituents.id))
      .$dynamic();
    let countQuery = tx
      .select({ count: sql<number>`count(*)` })
      .from(constituents)
      .leftJoin(donationAggregate, eq(donationAggregate.constituentId, constituents.id))
      .$dynamic();
    if (query.advancedFilter) {
      const dataJoin = donationStatsJoin(orgId);
      const countJoin = donationStatsJoin(orgId);
      dataQuery = dataQuery.leftJoin(dataJoin.source, dataJoin.on);
      countQuery = countQuery.leftJoin(countJoin.source, countJoin.on);
    }

    const [data, countResult] = await Promise.all([
      dataQuery
        .where(where)
        .orderBy(...buildConstituentOrderBy(sort, order, donationAggregate.lastDonationAt))
        .limit(perPage)
        .offset(offset),
      countQuery.where(where),
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

/** Get a single constituent by ID */
export async function getConstituent(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(constituents)
      .where(
        and(eq(constituents.id, id), eq(constituents.orgId, orgId), isNull(constituents.deletedAt)),
      );

    if (!row) return null;

    return { ...row, activities: [] };
  });
}

/** Create a new constituent in an organization */
export async function createConstituent(orgId: string, input: ConstituentInput) {
  return withTenantContext(orgId, async (tx) => {
    // Strip the two raw type inputs and replace with the reconciled column
    // patch so we never write a stale `type`/`types` pair.
    const { type: _legacyType, types: _types, ...rest } = input;
    const [result] = await tx
      .insert(constituents)
      .values({ ...rest, ...reconcileTypeColumns(input), orgId })
      .returning();

    return result;
  });
}

/** Update a constituent */
export async function updateConstituent(
  orgId: string,
  id: string,
  input: Partial<ConstituentInput>,
  userId: string,
) {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(constituents)
      .where(
        and(eq(constituents.id, id), eq(constituents.orgId, orgId), isNull(constituents.deletedAt)),
      );

    if (!existing) return null;

    const { type: _legacyType, types: _types, ...rest } = input;
    const [updated] = await tx
      .update(constituents)
      // `reconcileTypeColumns` returns `{}` when neither type field is in the
      // patch, leaving the existing `type`/`types` columns untouched.
      .set({ ...rest, ...reconcileTypeColumns(input), updatedAt: new Date() })
      .where(eq(constituents.id, id))
      .returning();

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "constituent.updated",
      payload: { constituentId: id, changes: input, updatedBy: userId },
    });

    return updated;
  });
}

/** Soft-delete a constituent */
export async function deleteConstituent(orgId: string, id: string, userId: string) {
  return withTenantContext(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(constituents)
      .where(
        and(eq(constituents.id, id), eq(constituents.orgId, orgId), isNull(constituents.deletedAt)),
      );

    if (!existing) return null;

    const now = new Date();
    const [deleted] = await tx
      .update(constituents)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(constituents.id, id))
      .returning();

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "constituent.deleted",
      payload: { constituentId: id, deletedBy: userId },
    });

    return deleted;
  });
}

export interface DuplicateSearchInput {
  firstName: string;
  lastName: string;
  email?: string;
}

export interface DuplicateMatch {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  // TODO(#465 follow-up): reads the legacy scalar `type` only. Correct during
  // the back-compat shadow window (`type === types[0]`), but the migration that
  // DROPS the `type` column must switch this projection to `types`, or
  // duplicate-match results silently lose their type data.
  type: string;
  score: number;
}

/** Find potential duplicate constituents using trigram similarity and exact email match */
export async function findDuplicates(
  orgId: string,
  input: DuplicateSearchInput,
): Promise<DuplicateMatch[]> {
  return withTenantContext(orgId, async (tx) => {
    // Build a score from trigram similarity on names + exact email match
    // similarity() returns 0..1; we weight first+last name and add a bonus for email match
    const rows = await tx.execute(sql`
      SELECT
        id,
        first_name AS "firstName",
        last_name AS "lastName",
        email,
        type,
        (
          similarity(first_name, ${input.firstName}) * 0.35
          + similarity(last_name, ${input.lastName}) * 0.35
          + CASE WHEN ${input.email ?? null}::text IS NOT NULL
                      AND email IS NOT NULL
                      AND lower(email) = lower(${input.email ?? null}::text)
                 THEN 0.30
                 ELSE 0.0
            END
        ) AS score
      FROM constituents
      WHERE org_id = ${orgId}
        AND deleted_at IS NULL
        AND (
          similarity(first_name, ${input.firstName}) > 0.3
          OR similarity(last_name, ${input.lastName}) > 0.3
          OR (
            ${input.email ?? null}::text IS NOT NULL
            AND email IS NOT NULL
            AND lower(email) = lower(${input.email ?? null}::text)
          )
        )
      ORDER BY score DESC, created_at DESC
      LIMIT 10
    `);

    return (rows.rows as unknown as DuplicateMatch[]).filter((r) => r.score >= 0.3);
  });
}

export interface MergeActor {
  userId: string;
  /** Impersonating admin (RFC 8693 `act.sub`), if any. Null under normal auth. */
  actorId?: string | null;
}

/**
 * Thrown when an `If-Match` header was supplied but the survivor's current
 * state has moved on since the caller fetched it. Route handler maps this to
 * 409 Conflict so clients can refetch and decide whether to retry.
 */
export class MergePreconditionError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super("If-Match precondition failed — survivor has been modified concurrently");
    this.name = "MergePreconditionError";
  }
}

/**
 * Weak ETag for a constituent row — `id + updatedAt` millis. Good enough to
 * detect "this row has been written since I read it". Weak (`W/"..."`) because
 * we don't hash response bodies; strong semantics aren't needed for merge
 * pre-check.
 */
export function constituentEtag(row: { id: string; updatedAt: Date }): string {
  return `W/"${row.id}-${row.updatedAt.getTime()}"`;
}

export interface MergeOptions {
  /** Optional `If-Match` — if present, must match the survivor's current ETag. */
  ifMatch?: string;
}

/** Merge a duplicate constituent into a primary (survivor) constituent */
export async function mergeConstituents(
  orgId: string,
  primaryId: string,
  duplicateId: string,
  actor: MergeActor,
  options: MergeOptions = {},
): Promise<{ merged: true; etag: string } | null> {
  if (primaryId === duplicateId) {
    throw new Error("Cannot merge a constituent into itself");
  }

  return withTenantContext(orgId, async (tx) => {
    // Lock the survivor row for the duration of the tx. Postgres runs
    // `withTenantContext` at READ COMMITTED, so without a row lock two
    // concurrent mergers could both read the same survivor snapshot, both
    // pass If-Match, and both apply — even though only one should succeed
    // (PR #142 review H3). `FOR UPDATE` serialises the tail of the merge
    // against any other writer touching this row, including another merge.
    const [primary] = await tx
      .select()
      .from(constituents)
      .where(
        and(
          eq(constituents.id, primaryId),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      )
      .for("update");

    // The duplicate doesn't strictly need a row lock (we're soft-deleting it,
    // not racing its updatedAt), but we still want it serialised against
    // concurrent mergers trying to use the SAME duplicate as the target of
    // two different merges — the second should see it already deleted.
    const [duplicate] = await tx
      .select()
      .from(constituents)
      .where(
        and(
          eq(constituents.id, duplicateId),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      )
      .for("update");

    if (!primary || !duplicate) return null;

    // Optimistic concurrency: if the caller supplied `If-Match`, reject the
    // merge when the survivor has moved on since they read it. Combined
    // with the `FOR UPDATE` above, this is race-free — any concurrent writer
    // is blocked on the row lock until we commit, so our current `primary`
    // snapshot IS the up-to-date one. Issue #56 API #6.
    if (options.ifMatch) {
      const currentEtag = constituentEtag(primary);
      if (options.ifMatch !== currentEtag) {
        throw new MergePreconditionError(options.ifMatch, currentEtag);
      }
    }

    // Fill null fields on primary with values from duplicate
    const fieldsToFill: Partial<ConstituentInput> = {};
    if (!primary.email && duplicate.email) fieldsToFill.email = duplicate.email;
    if (!primary.phone && duplicate.phone) fieldsToFill.phone = duplicate.phone;

    // Merge tags (union, deduplicate)
    const primaryTags = primary.tags ?? [];
    const duplicateTags = duplicate.tags ?? [];
    const mergedTags = [...new Set([...primaryTags, ...duplicateTags])];

    const now = new Date();

    // Update primary with filled fields + merged tags — `.returning()` so we
    // can capture the post-merge state for the audit snapshot below.
    const [survivorAfter] = await tx
      .update(constituents)
      .set({ ...fieldsToFill, tags: mergedTags, updatedAt: now })
      .where(eq(constituents.id, primaryId))
      .returning();

    // Move all donations from duplicate to primary
    await tx
      .update(donations)
      .set({ constituentId: primaryId, updatedAt: now })
      .where(and(eq(donations.constituentId, duplicateId), eq(donations.orgId, orgId)));

    // Soft-delete the duplicate
    await tx
      .update(constituents)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(constituents.id, duplicateId));

    // GDPR Art. 5(2) accountability snapshot — before/after PII of BOTH
    // records must be reconstructable from audit trail. Scalar fields (ids,
    // mergedBy*) go to audit_logs via the normal plugin; the JSONB PII
    // snapshot lives in merge_history under the same tenant isolation.
    // Double-attribution: `mergedByActorId` distinguishes impersonated merges
    // from direct admin merges (issue #24 / #56 Security #16).
    await tx.insert(mergeHistory).values({
      orgId,
      survivorId: primaryId,
      mergedId: duplicateId,
      mergedByUserId: actor.userId,
      mergedByActorId: actor.actorId ?? null,
      survivorBefore: primary,
      mergedBefore: duplicate,
      survivorAfter: survivorAfter ?? primary,
    });

    // Emit events in the same transaction
    await tx.insert(outboxEvents).values([
      {
        tenantId: orgId,
        type: "constituent.merged",
        payload: {
          survivorId: primaryId,
          mergedId: duplicateId,
          mergedBy: actor.userId,
          mergedByActor: actor.actorId ?? null,
        },
      },
      {
        tenantId: orgId,
        type: "constituent.deleted",
        payload: { constituentId: duplicateId, deletedBy: actor.userId, reason: "merged" },
      },
    ]);

    return {
      merged: true,
      etag: constituentEtag(survivorAfter ?? { id: primaryId, updatedAt: now }),
    };
  });
}
