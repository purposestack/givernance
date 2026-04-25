/** Constituent service — business logic for constituent operations */

import { constituents, donations, mergeHistory, outboxEvents } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, arrayOverlaps, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface ListConstituentsQuery {
  page: number;
  perPage: number;
  search?: string;
  tags?: string[];
  type?: string;
  includeDeleted?: boolean;
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
  type?: string;
  tags?: string[];
}

/** List constituents for an organization with pagination, search, and filtering */
export async function listConstituents(orgId: string, query: ListConstituentsQuery) {
  const { page, perPage, search, tags, type, includeDeleted } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const conditions = [eq(constituents.orgId, orgId)];

    if (!includeDeleted) {
      conditions.push(isNull(constituents.deletedAt));
    }

    if (search) {
      const pattern = `%${search}%`;
      const searchCondition = or(
        ilike(constituents.firstName, pattern),
        ilike(constituents.lastName, pattern),
        ilike(constituents.email, pattern),
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    if (type) {
      conditions.push(eq(constituents.type, type));
    }

    if (tags && tags.length > 0) {
      // Drizzle's `arrayOverlaps` compiles to `col && ARRAY[...]::text[]` with
      // every tag bound as a proper parameter — no SQL interpolation of
      // user-supplied strings. Replaces the old `sql.raw` + manual `''` escape
      // (issue #56 Security #7), which worked in practice but was a
      // correctness footgun one typo away from SQL injection.
      conditions.push(arrayOverlaps(constituents.tags, tags));
    }

    const where = and(...conditions);

    const [data, countResult] = await Promise.all([
      tx.select().from(constituents).where(where).limit(perPage).offset(offset),
      tx.select({ count: sql<number>`count(*)` }).from(constituents).where(where),
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
    const [result] = await tx
      .insert(constituents)
      .values({ ...input, orgId })
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

    const [updated] = await tx
      .update(constituents)
      .set({ ...input, updatedAt: new Date() })
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: merge orchestration is sequential by design (lock survivor → load duplicate → merge fields → repoint donations → audit → soft-delete). Splitting it would obscure the tx boundary.
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
