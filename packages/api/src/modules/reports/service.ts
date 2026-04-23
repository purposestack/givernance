/** Reports service — donor lifecycle analytics (LYBUNT/SYBUNT) */

import { outboxEvents } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface LifecycleConstituent {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  lastDonationAt: string;
  totalDonatedCents: number;
}

export interface ReportPagination {
  limit: number;
  offset: number;
}

/**
 * LYBUNT — Last Year But Unfortunately Not This.
 * Returns constituents who donated in the previous calendar year but not in the current year.
 */
export async function getLybuntReport(
  orgId: string,
  referenceYear?: number,
  pagination?: ReportPagination,
  userId?: string,
) {
  const thisYear = referenceYear ?? new Date().getFullYear();
  const lastYear = thisYear - 1;
  const lastYearStart = `${lastYear}-01-01`;
  const lastYearEnd = `${lastYear + 1}-01-01`;
  const thisYearStart = `${thisYear}-01-01`;
  const thisYearEnd = `${thisYear + 1}-01-01`;
  const limit = pagination?.limit ?? 100;
  const offset = pagination?.offset ?? 0;

  return withTenantContext(orgId, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        c.id,
        c.first_name AS "firstName",
        c.last_name  AS "lastName",
        c.email,
        MAX(d.donated_at)::text AS "lastDonationAt",
        COALESCE(SUM(d.amount_base_cents), 0)::int AS "totalDonatedCents"
      FROM constituents c
      INNER JOIN donations d ON d.constituent_id = c.id AND d.org_id = c.org_id
      WHERE c.org_id = ${orgId}
        AND c.deleted_at IS NULL
        AND d.donated_at >= ${lastYearStart}::timestamptz
        AND d.donated_at < ${lastYearEnd}::timestamptz
        AND NOT EXISTS (
          SELECT 1
          FROM donations d2
          WHERE d2.constituent_id = c.id
            AND d2.org_id = ${orgId}
            AND d2.donated_at >= ${thisYearStart}::timestamptz
            AND d2.donated_at < ${thisYearEnd}::timestamptz
        )
      GROUP BY c.id, c.first_name, c.last_name, c.email
      ORDER BY "totalDonatedCents" DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const results = rows.rows as unknown as LifecycleConstituent[];

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "reports.lybunt_exported",
      payload: {
        year: thisYear,
        resultCount: results.length,
        exportedBy: userId,
      },
    });

    return results;
  });
}

/**
 * SYBUNT — Some Year But Unfortunately Not This.
 * Returns constituents who donated in any past year but not in the current year.
 */
export async function getSybuntReport(
  orgId: string,
  referenceYear?: number,
  pagination?: ReportPagination,
  userId?: string,
) {
  const thisYear = referenceYear ?? new Date().getFullYear();
  const thisYearStart = `${thisYear}-01-01`;
  const thisYearEnd = `${thisYear + 1}-01-01`;
  const limit = pagination?.limit ?? 100;
  const offset = pagination?.offset ?? 0;

  return withTenantContext(orgId, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        c.id,
        c.first_name AS "firstName",
        c.last_name  AS "lastName",
        c.email,
        MAX(d.donated_at)::text AS "lastDonationAt",
        COALESCE(SUM(d.amount_base_cents), 0)::int AS "totalDonatedCents"
      FROM constituents c
      INNER JOIN donations d ON d.constituent_id = c.id AND d.org_id = c.org_id
      WHERE c.org_id = ${orgId}
        AND c.deleted_at IS NULL
        AND d.donated_at < ${thisYearStart}::timestamptz
        AND NOT EXISTS (
          SELECT 1
          FROM donations d2
          WHERE d2.constituent_id = c.id
            AND d2.org_id = ${orgId}
            AND d2.donated_at >= ${thisYearStart}::timestamptz
            AND d2.donated_at < ${thisYearEnd}::timestamptz
        )
      GROUP BY c.id, c.first_name, c.last_name, c.email
      ORDER BY "totalDonatedCents" DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const results = rows.rows as unknown as LifecycleConstituent[];

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "reports.sybunt_exported",
      payload: {
        year: thisYear,
        resultCount: results.length,
        exportedBy: userId,
      },
    });

    return results;
  });
}
