/**
 * Worker-side feature flag evaluator. Mirrors the API's
 * `flag-service.ts` but reads PG directly via the worker's owner-role
 * pool — no Redis cache. Workers are stateless and check a flag at
 * most once per job; the round-trip to PG is in the noise next to the
 * SMTP send / S3 upload that follows.
 *
 * Why a worker-side copy (rather than an HTTP call into the API): the
 * worker process must not depend on the API process being up. Flag
 * evaluation is a critical-path defence-in-depth check for any gated
 * processor — if the API was down at deploy time, the worker must
 * still correctly drop disabled-feature jobs.
 *
 * Same posture as the API:
 *   - Unknown keys evaluate to `false` (doc 18 §5).
 *   - Errors are surfaced (don't silently say "enabled" on a DB
 *     failure — that's how a flagged-off feature accidentally fires).
 */

import { featureFlags } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "./db.js";

export async function isFlagEnabled(key: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(eq(featureFlags.key, key))
    .limit(1);
  return row?.enabled === true;
}
