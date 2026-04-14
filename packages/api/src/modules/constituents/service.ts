/** Constituent service — business logic for constituent operations */

import { constituents, outboxEvents } from "@givernance/shared/schema";
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
