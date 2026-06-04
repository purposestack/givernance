/**
 * Pure routing decision for outbox events (issue #152).
 *
 * Translates the `(type, payload)` pair emitted by the API's transactional
 * outbox into a discriminated union describing which downstream side
 * effect the worker should perform. The function is intentionally pure
 * (no Redis, no BullMQ, no DB) so the type-routing decisions can be
 * exercised in unit tests without booting the worker singletons in
 * `worker.ts`.
 *
 * What lives here:
 * - Mapping outbox `type` strings → routing kinds (collapsing the
 *   3-type team-invite family and 2-type signup family into single
 *   kinds so the worker switch stays small).
 * - Payload destructuring with the same `as string` / cast pattern the
 *   worker used inline.
 * - Locale resolution (already a pure helper) for email-bearing kinds.
 *
 * What does NOT live here:
 * - Queue name picks, job id derivation, BullMQ `add(...)` calls — those
 *   are side-effecting and stay in `worker.ts`.
 * - Time-dependent values (e.g. donation receipt `fiscalYear =
 *   new Date().getFullYear()`) — those are computed in the worker so
 *   the routing decision stays deterministic for a given input.
 */

import type { Locale } from "@givernance/shared/i18n";
import { BRANDING_EVENT_TYPES } from "@givernance/shared/jobs";
import { resolvePayloadLocale } from "./payload-locale.js";

export interface RoutingInput {
  /** Outbox event id (used downstream as a job-id suffix for some kinds). */
  id: string;
  /** Tenant scope captured at outbox write time. */
  tenantId: string;
  /** Discriminator — the `outbox_events.type` column. */
  type: string;
  /** Untyped payload column; cast at the boundary. */
  payload: Record<string, unknown>;
  /** W3C trace context to thread through child jobs. */
  traceparent?: string;
}

export type RoutingDecision =
  | {
      kind: "camt053-import";
      statementId: string;
      bankAccountId: string;
      orgId: string;
      traceparent?: string;
    }
  | {
      kind: "camt053-reconcile";
      statementId: string;
      orgId: string;
      traceparent?: string;
    }
  | {
      kind: "donation-receipt";
      donationId: string;
      orgId: string;
      traceparent?: string;
    }
  | {
      kind: "campaign-documents";
      campaignId: string;
      orgId: string;
      constituentIds: string[];
      traceparent?: string;
    }
  | {
      kind: "postal-export";
      exportId: string;
      campaignId: string;
      orgId: string;
      mode: "door_drop" | "personalized";
      traceparent?: string;
    }
  | {
      kind: "bulk-email";
      outboxId: string;
      orgId: string;
      bulkEmailJobId: string;
      traceparent?: string;
    }
  | {
      kind: "signup-email";
      tenantId: string;
      invitationId: string;
      expiresAt: string;
      locale: Locale;
    }
  | {
      kind: "team-invite-email";
      tenantId: string;
      invitationId: string;
      inviterUserId: string | null;
      locale: Locale;
    }
  | {
      kind: "platform-admin-invite";
      invitationId: string;
      locale: Locale;
    }
  | {
      kind: "branding-process-asset";
      assetId: string;
      orgId: string;
      traceparent?: string;
    }
  | {
      kind: "branding-activate-logo";
      assetId: string;
      orgId: string;
      traceparent?: string;
    }
  | {
      kind: "branding-gc-asset";
      assetId: string;
      orgId: string;
      prefix: string;
      traceparent?: string;
    }
  | {
      kind: "keycloak-sync-org-logo";
      orgId: string;
      traceparent?: string;
    }
  | {
      kind: "bulk-import";
      outboxId: string;
      orgId: string;
      bulkImportJobId: string;
      traceparent?: string;
    }
  | {
      kind: "survey-invitation-email";
      invitationId: string;
      surveyId: string;
      surveySlug: string;
      email: string;
      userId: string | null;
      expiresAt: string;
      source: string;
      locale: Locale;
      traceparent?: string;
    }
  | { kind: "unhandled"; type: string };

export function routeDomainEvent(input: RoutingInput): RoutingDecision {
  const { id, tenantId, type, payload, traceparent } = input;

  if (type === "camt053.uploaded") {
    return {
      kind: "camt053-import",
      statementId: payload.statementId as string,
      bankAccountId: payload.bankAccountId as string,
      orgId: tenantId,
      traceparent,
    };
  }

  if (type === "camt053.imported") {
    return {
      kind: "camt053-reconcile",
      statementId: payload.statementId as string,
      orgId: tenantId,
      traceparent,
    };
  }

  if (type === "donation.created") {
    return {
      kind: "donation-receipt",
      donationId: payload.donationId as string,
      orgId: tenantId,
      traceparent,
    };
  }

  if (type === "campaign.documents_requested") {
    return {
      kind: "campaign-documents",
      campaignId: payload.campaignId as string,
      orgId: tenantId,
      constituentIds: payload.constituentIds as string[],
      traceparent,
    };
  }

  if (type === "campaign.postal_export_requested") {
    return {
      kind: "postal-export",
      exportId: payload.exportId as string,
      campaignId: payload.campaignId as string,
      orgId: tenantId,
      mode: payload.mode as "door_drop" | "personalized",
      traceparent,
    };
  }

  if (type === "communication.bulk_email_requested") {
    return {
      kind: "bulk-email",
      outboxId: id,
      orgId: tenantId,
      bulkEmailJobId: payload.bulkEmailJobId as string,
      traceparent,
    };
  }

  if (
    type === "tenant.signup_verification_requested" ||
    type === "tenant.signup_verification_resent"
  ) {
    return {
      kind: "signup-email",
      tenantId,
      invitationId: payload.invitationId as string,
      expiresAt: payload.expiresAt as string,
      locale: resolvePayloadLocale(payload),
    };
  }

  if (
    type === "invitation.created" ||
    type === "invitation.resent" ||
    type === "tenant.first_admin_invited"
  ) {
    return {
      kind: "team-invite-email",
      tenantId,
      invitationId: payload.invitationId as string,
      inviterUserId: typeof payload.inviterUserId === "string" ? payload.inviterUserId : null,
      locale: resolvePayloadLocale(payload),
    };
  }

  if (type === "platform_admin.invited") {
    return {
      kind: "platform-admin-invite",
      invitationId: payload.invitationId as string,
      locale: resolvePayloadLocale(payload),
    };
  }

  if (type === BRANDING_EVENT_TYPES.PROCESS_ASSET) {
    return {
      kind: "branding-process-asset",
      assetId: payload.assetId as string,
      orgId: tenantId,
      traceparent,
    };
  }

  if (type === BRANDING_EVENT_TYPES.ACTIVATE_LOGO) {
    return {
      kind: "branding-activate-logo",
      assetId: payload.assetId as string,
      orgId: tenantId,
      traceparent,
    };
  }

  if (type === BRANDING_EVENT_TYPES.GC_ASSET) {
    return {
      kind: "branding-gc-asset",
      assetId: payload.assetId as string,
      orgId: tenantId,
      prefix: payload.prefix as string,
      traceparent,
    };
  }

  if (type === BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO) {
    return {
      kind: "keycloak-sync-org-logo",
      orgId: tenantId,
      traceparent,
    };
  }

  if (type === "constituents.bulk_import_requested") {
    return {
      kind: "bulk-import",
      outboxId: id,
      orgId: tenantId,
      bulkImportJobId: payload.bulkImportJobId as string,
      traceparent,
    };
  }

  const surveyEmail = routeSurveyInvitationEmail({ type, payload, traceparent });
  if (surveyEmail) return surveyEmail;

  return { kind: "unhandled", type };
}

/**
 * Extracted because inlining the branch pushed `routeDomainEvent` over
 * the cognitive-complexity budget (issue #444 follow-up). Returns
 * `null` when the event type doesn't match — caller falls through to
 * the next routing branch.
 */
function routeSurveyInvitationEmail(input: {
  type: string;
  payload: Record<string, unknown>;
  traceparent?: string;
}): Extract<RoutingDecision, { kind: "survey-invitation-email" }> | null {
  if (input.type !== "survey.invitation.send_email") return null;
  const { payload, traceparent } = input;
  return {
    kind: "survey-invitation-email",
    invitationId: payload.invitationId as string,
    surveyId: payload.surveyId as string,
    surveySlug: payload.surveySlug as string,
    email: payload.email as string,
    userId: typeof payload.userId === "string" ? payload.userId : null,
    expiresAt: payload.expiresAt as string,
    source: typeof payload.source === "string" ? payload.source : "unknown",
    locale: resolvePayloadLocale(payload),
    traceparent,
  };
}
