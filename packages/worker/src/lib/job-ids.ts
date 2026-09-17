/**
 * BullMQ job-id derivation for outbox-routed jobs whose id must NOT be
 * keyed on the entity (issue #612).
 *
 * BullMQ dedupes `add()` on `jobId` against a job in ANY state — including
 * `completed` / `failed` for as long as the job is retained. A per-entity
 * id on a job that legitimately recurs for the same entity therefore
 * means "runs once, every later event is silently dropped". Both jobs
 * below recur (a tenant changes its logo many times; a campaign gets
 * several document batches) and both processors read current state, so
 * an extra run is harmless. Keying on the outbox event id keeps the
 * property we actually need — a relay redelivery of the SAME outbox row
 * collapses onto one job — without burning the id for the next event.
 *
 * Pure (no Redis / BullMQ) so the contract is unit-testable.
 */

/** `keycloak.sync_org_logo` — one job per outbox event, not per tenant. */
export function keycloakSyncOrgLogoJobId(outboxId: string): string {
  return `kc-sync-org-logo-${outboxId}`;
}

/** `generate-campaign-documents` — one job per outbox event, not per campaign. */
export function campaignDocumentsJobId(outboxId: string): string {
  return `campaign-docs-${outboxId}`;
}
