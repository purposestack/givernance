/** Loader — bulk insert transformed records into Givernance database */

import { constituents } from "@givernance/shared/schema";
import type { ConstituentCreate } from "@givernance/shared/validators";
import { db } from "./db.js";

const BATCH_SIZE = 500;

/** Bulk insert constituents in batches */
export async function bulkInsertConstituents(
  orgId: string,
  records: ConstituentCreate[],
  options: { dryRun?: boolean } = {},
): Promise<{ inserted: number }> {
  if (options.dryRun) {
    console.error(`[dry-run] Would insert ${records.length} constituents`);
    return { inserted: 0 };
  }

  let inserted = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const values = batch.map((r) => ({ ...r, orgId }));

    await db.insert(constituents).values(values);
    inserted += batch.length;

    console.error(`Inserted ${inserted}/${records.length} constituents`);
  }

  return { inserted };
}
