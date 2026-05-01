/**
 * Impersonation context helper for worker processors (issue #24).
 *
 * The relay forwards `impersonationSessionId` / `impersonationMode` /
 * `impersonatorKeycloakId` from `outbox_events.metadata` into the BullMQ
 * job payload. Processors that write to `audit_logs` should read these
 * out and pass them to the audit insert so async work mutating tenant
 * data carries the same double-attribution as the originating request.
 *
 * Job payloads from non-impersonated requests have all three fields
 * undefined; the helper returns `null` in that case so callers can
 * spread the result with the `??` shape.
 */

import type { ImpersonationModeName } from "@givernance/shared/types";

export interface ImpersonationJobMeta {
  sessionId: string;
  mode: ImpersonationModeName;
  impersonatorKeycloakId: string;
}

/** Read impersonation metadata off a BullMQ job's data payload. */
export function readImpersonationMeta(jobData: unknown): ImpersonationJobMeta | null {
  if (!jobData || typeof jobData !== "object") return null;
  const data = jobData as Record<string, unknown>;
  const sessionId = data.impersonationSessionId;
  const mode = data.impersonationMode;
  const impersonator = data.impersonatorKeycloakId;
  if (
    typeof sessionId !== "string" ||
    typeof impersonator !== "string" ||
    (mode !== "delegation" && mode !== "impersonation")
  ) {
    return null;
  }
  return { sessionId, mode, impersonatorKeycloakId: impersonator };
}

/**
 * Convenience: derive the partial Drizzle insert payload that audit_logs
 * accepts for impersonation columns. Designed to be spread into the
 * insert: `tx.insert(auditLogs).values({ ..., ...auditFields(meta) })`.
 */
export function impersonationAuditFields(meta: ImpersonationJobMeta | null): {
  actorId: string | null;
  impersonationSessionId: string | null;
  impersonationMode: ImpersonationModeName | null;
} {
  if (!meta) {
    return { actorId: null, impersonationSessionId: null, impersonationMode: null };
  }
  return {
    actorId: meta.impersonatorKeycloakId,
    impersonationSessionId: meta.sessionId,
    impersonationMode: meta.mode,
  };
}
