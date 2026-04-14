/** Constituent service — business logic for constituent operations */

import { constituents } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import type { ConstituentCreate, PaginationQuery } from "@givernance/shared/validators";
import { eq, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

/** List constituents for an organization with pagination */
export async function listConstituents(orgId: string, query: PaginationQuery) {
  const { page, perPage } = query;
  const offset = (page - 1) * perPage;

  return withTenantContext(orgId, async (tx) => {
    const [data, countResult] = await Promise.all([
      tx
        .select()
        .from(constituents)
        .where(eq(constituents.orgId, orgId))
        .limit(perPage)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)` })
        .from(constituents)
        .where(eq(constituents.orgId, orgId)),
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

/** Create a new constituent in an organization */
export async function createConstituent(orgId: string, input: ConstituentCreate) {
  return withTenantContext(orgId, async (tx) => {
    const [result] = await tx
      .insert(constituents)
      .values({ ...input, orgId })
      .returning();

    return result;
  });
}
