/**
 * Audit-diff sanitizer (Epic #539, GDPR posture — docs/35 §6).
 *
 * The `custom` JSONB blob on constituents / donations / campaigns holds
 * operator-defined values the platform cannot classify — it may carry
 * Art. 9 data. Long-retention stores (audit_logs, outbox payloads)
 * therefore never receive the blob itself: entity diffs record only
 * `{ customKeysChanged: [keys] }`. Definition keys are schema metadata,
 * not PII. Definition/option/quota metadata diffs are NOT routed through
 * this helper — they get full diffs.
 */

/**
 * Strips the `custom` blob from an entity change-set, replacing it with
 * the list of touched keys. Change-sets without a `custom` entry pass
 * through as a shallow copy.
 */
export function sanitizeAuditDiff(diff: Record<string, unknown>): Record<string, unknown> {
  if (!("custom" in diff)) {
    return { ...diff };
  }
  const { custom, ...rest } = diff;
  const customKeysChanged =
    custom !== null && typeof custom === "object" && !Array.isArray(custom)
      ? Object.keys(custom)
      : [];
  return { ...rest, customKeysChanged };
}
