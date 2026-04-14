/** Constituent service — business logic for constituent operations */

import { constituents, donations, outboxEvents } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
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
  email?: string;
  phone?: string;
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
      conditions.push(
        sql`${constituents.tags} && ${sql.raw(`ARRAY[${tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]::text[]`)}`,
      );
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

/** Merge a duplicate constituent into a primary (survivor) constituent */
export async function mergeConstituents(
  orgId: string,
  primaryId: string,
  duplicateId: string,
  userId: string,
): Promise<{ merged: true } | null> {
  if (primaryId === duplicateId) {
    throw new Error("Cannot merge a constituent into itself");
  }

  return withTenantContext(orgId, async (tx) => {
    // Fetch both constituents (must be in same org, not deleted)
    const [primary] = await tx
      .select()
      .from(constituents)
      .where(
        and(
          eq(constituents.id, primaryId),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      );

    const [duplicate] = await tx
      .select()
      .from(constituents)
      .where(
        and(
          eq(constituents.id, duplicateId),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      );

    if (!primary || !duplicate) return null;

    // Fill null fields on primary with values from duplicate
    const fieldsToFill: Partial<ConstituentInput> = {};
    if (!primary.email && duplicate.email) fieldsToFill.email = duplicate.email;
    if (!primary.phone && duplicate.phone) fieldsToFill.phone = duplicate.phone;

    // Merge tags (union, deduplicate)
    const primaryTags = primary.tags ?? [];
    const duplicateTags = duplicate.tags ?? [];
    const mergedTags = [...new Set([...primaryTags, ...duplicateTags])];

    const now = new Date();

    // Update primary with filled fields + merged tags
    await tx
      .update(constituents)
      .set({ ...fieldsToFill, tags: mergedTags, updatedAt: now })
      .where(eq(constituents.id, primaryId));

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

    // Emit events in the same transaction
    await tx.insert(outboxEvents).values([
      {
        tenantId: orgId,
        type: "constituent.merged",
        payload: { survivorId: primaryId, mergedId: duplicateId, mergedBy: userId },
      },
      {
        tenantId: orgId,
        type: "constituent.deleted",
        payload: { constituentId: duplicateId, deletedBy: userId, reason: "merged" },
      },
    ]);

    return { merged: true };
  });
}
