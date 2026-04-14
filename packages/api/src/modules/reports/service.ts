/** Reports service — donor lifecycle analytics (LYBUNT/SYBUNT) */

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

/**
 * LYBUNT — Last Year But Unfortunately Not This.
 * Returns constituents who donated in the previous calendar year but not in the current year.
 */
export async function getLybuntReport(orgId: string, referenceYear?: number) {
  const thisYear = referenceYear ?? new Date().getFullYear();
  const lastYear = thisYear - 1;

  return withTenantContext(orgId, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        c.id,
        c.first_name AS "firstName",
        c.last_name  AS "lastName",
        c.email,
        MAX(d.donated_at)::text AS "lastDonationAt",
        COALESCE(SUM(d.amount_cents), 0)::int AS "totalDonatedCents"
      FROM constituents c
      INNER JOIN donations d ON d.constituent_id = c.id AND d.org_id = c.org_id
      WHERE c.org_id = ${orgId}
        AND c.deleted_at IS NULL
        AND EXTRACT(YEAR FROM d.donated_at) = ${lastYear}
        AND c.id NOT IN (
          SELECT d2.constituent_id
          FROM donations d2
          WHERE d2.org_id = ${orgId}
            AND EXTRACT(YEAR FROM d2.donated_at) = ${thisYear}
        )
      GROUP BY c.id, c.first_name, c.last_name, c.email
      ORDER BY "totalDonatedCents" DESC
    `);

    return rows.rows as unknown as LifecycleConstituent[];
  });
}

/**
 * SYBUNT — Some Year But Unfortunately Not This.
 * Returns constituents who donated in any past year but not in the current year.
 */
export async function getSybuntReport(orgId: string, referenceYear?: number) {
  const thisYear = referenceYear ?? new Date().getFullYear();

  return withTenantContext(orgId, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        c.id,
        c.first_name AS "firstName",
        c.last_name  AS "lastName",
        c.email,
        MAX(d.donated_at)::text AS "lastDonationAt",
        COALESCE(SUM(d.amount_cents), 0)::int AS "totalDonatedCents"
      FROM constituents c
      INNER JOIN donations d ON d.constituent_id = c.id AND d.org_id = c.org_id
      WHERE c.org_id = ${orgId}
        AND c.deleted_at IS NULL
        AND EXTRACT(YEAR FROM d.donated_at) < ${thisYear}
        AND c.id NOT IN (
          SELECT d2.constituent_id
          FROM donations d2
          WHERE d2.org_id = ${orgId}
            AND EXTRACT(YEAR FROM d2.donated_at) = ${thisYear}
        )
      GROUP BY c.id, c.first_name, c.last_name, c.email
      ORDER BY "totalDonatedCents" DESC
    `);

    return rows.rows as unknown as LifecycleConstituent[];
  });
}
