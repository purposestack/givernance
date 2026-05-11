/**
 * Admin-side feature-flag service (issue #326 / PR #352 follow-up).
 *
 * Owns the WRITE path — flips `feature_flags.enabled` and returns
 * the resulting row + the previous value so the route's structured
 * log line can record a BEFORE/AFTER discriminator without an extra
 * round-trip.
 *
 * Reads live in `lib/flags/flag-service.ts`. The split matches the
 * rest of the admin module shape: read-cache concerns ≠ write/audit
 * concerns.
 */

import { featureFlags } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../lib/db.js";

export interface FlagToggleResult {
  row: {
    key: string;
    enabled: boolean;
    label: string;
    description: string;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  /** Value before this PATCH. Useful for BEFORE/AFTER audit log lines. */
  previousEnabled: boolean;
}

/**
 * Flip a flag's `enabled` to the supplied value. Returns `null` when
 * the key isn't in the registry — the route renders that as a 404
 * (anti-disclosure: same response shape as a typo'd URL).
 *
 * `updatedBy` is the internal users.id when available (always null for
 * platform-admin super-admins; tenant-admin flags would carry their
 * users.id if the flag-edit surface ever opens up tenant-side).
 *
 * No-ops (current value already matches the requested value) still
 * bump `updated_at` so the audit_logs row is queryable as "the
 * admin clicked Save at 14:32" even when nothing changed.
 */
export async function setFeatureFlag(
  key: string,
  enabled: boolean,
  updatedBy: string | null,
): Promise<FlagToggleResult | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);

    if (!current) return null;

    const [updated] = await tx
      .update(featureFlags)
      .set({ enabled, updatedBy, updatedAt: new Date() })
      .where(eq(featureFlags.key, key))
      .returning({
        key: featureFlags.key,
        enabled: featureFlags.enabled,
        label: featureFlags.label,
        description: featureFlags.description,
        updatedBy: featureFlags.updatedBy,
        createdAt: featureFlags.createdAt,
        updatedAt: featureFlags.updatedAt,
      });

    if (!updated) return null;

    return {
      row: {
        key: updated.key,
        enabled: updated.enabled,
        label: updated.label,
        description: updated.description,
        updatedBy: updated.updatedBy,
        createdAt:
          updated.createdAt instanceof Date
            ? updated.createdAt.toISOString()
            : String(updated.createdAt),
        updatedAt:
          updated.updatedAt instanceof Date
            ? updated.updatedAt.toISOString()
            : String(updated.updatedAt),
      },
      previousEnabled: current.enabled,
    };
  });
}
