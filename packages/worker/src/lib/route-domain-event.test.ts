import { describe, expect, it } from "vitest";

import { routeDomainEvent } from "./route-domain-event.js";

/**
 * Issue #152 — guards the type-routing decision of `processDomainEvent`.
 *
 * The integration-level processor suites (signup-email, team-invite-email,
 * receipt, campaigns, stripe-webhook) each stub their own underlying
 * function, so a typo in one of the dispatch strings — or accidentally
 * dropping an OR clause — would silently fall through to the `unhandled`
 * branch with no test failure. These pure-function assertions pin the
 * dispatch matrix instead.
 */
describe("routeDomainEvent (issue #152)", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const id = "22222222-2222-2222-2222-222222222222";
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

  it("routes donation.created → donation-receipt with the donationId and trace", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "donation.created",
      payload: { donationId: "donation-1" },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "donation-receipt",
      donationId: "donation-1",
      orgId: tenantId,
      traceparent,
    });
  });

  it("routes campaign.documents_requested → campaign-documents", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "campaign.documents_requested",
      payload: { campaignId: "c-1", constituentIds: ["x", "y"] },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "campaign-documents",
      campaignId: "c-1",
      orgId: tenantId,
      constituentIds: ["x", "y"],
      traceparent,
    });
  });

  it("collapses both signup verification types into a single signup-email decision", () => {
    // The function MUST treat the two outbox types as the same downstream
    // dispatch — the email shape is identical (`SignupEmailJobPayload`)
    // and the processor handles either path the same way. Without this
    // assertion, accidentally dropping the `||` from the OR-branch
    // would silently route resend events to `unhandled`.
    const requested = routeDomainEvent({
      id,
      tenantId,
      type: "tenant.signup_verification_requested",
      payload: { invitationId: "inv-1", expiresAt: "2026-06-01T00:00:00Z", locale: "fr" },
      traceparent,
    });
    const resent = routeDomainEvent({
      id,
      tenantId,
      type: "tenant.signup_verification_resent",
      payload: { invitationId: "inv-1", expiresAt: "2026-06-01T00:00:00Z", locale: "fr" },
      traceparent,
    });
    expect(requested).toEqual({
      kind: "signup-email",
      tenantId,
      invitationId: "inv-1",
      expiresAt: "2026-06-01T00:00:00Z",
      locale: "fr",
    });
    expect(resent).toEqual(requested);
  });

  it("falls back to APP_DEFAULT_LOCALE (fr) when the signup payload omits locale", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "tenant.signup_verification_requested",
      payload: { invitationId: "inv-1", expiresAt: "2026-06-01T00:00:00Z" },
      traceparent,
    });
    expect(decision).toMatchObject({ kind: "signup-email", locale: "fr" });
  });

  it.each([
    ["invitation.created", "team-invite for a brand-new invite"],
    ["invitation.resent", "team-invite for a rotated invite"],
    ["tenant.first_admin_invited", "team-invite for the super-admin first-admin path"],
  ])("collapses %s → team-invite-email (%s)", (type) => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type,
      payload: {
        invitationId: "inv-1",
        inviterUserId: "u-1",
        locale: "en",
      },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "team-invite-email",
      tenantId,
      invitationId: "inv-1",
      inviterUserId: "u-1",
      locale: "en",
    });
  });

  it("preserves null inviterUserId on team-invite when the field is missing or non-string", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "invitation.created",
      payload: { invitationId: "inv-1", locale: "en" },
      traceparent,
    });
    expect(decision).toMatchObject({ kind: "team-invite-email", inviterUserId: null });
  });

  it("routes platform_admin.invited → platform-admin-invite (separate from team-invite)", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "platform_admin.invited",
      payload: { invitationId: "inv-1", locale: "en" },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "platform-admin-invite",
      invitationId: "inv-1",
      locale: "en",
    });
  });

  it("routes campaign.postal_export_requested → postal-export", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "campaign.postal_export_requested",
      payload: { exportId: "exp-1", campaignId: "c-1", mode: "personalized" },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "postal-export",
      exportId: "exp-1",
      campaignId: "c-1",
      orgId: tenantId,
      mode: "personalized",
      traceparent,
    });
  });

  it("routes communication.bulk_email_requested → bulk-email and keeps the outbox id", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "communication.bulk_email_requested",
      payload: { bulkEmailJobId: "be-1" },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "bulk-email",
      outboxId: id,
      orgId: tenantId,
      bulkEmailJobId: "be-1",
      traceparent,
    });
  });

  it.each([
    ["branding.process_asset", "branding-process-asset"],
    ["branding.activate_logo", "branding-activate-logo"],
  ])("routes %s → %s", (type, kind) => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type,
      payload: { assetId: "a-1" },
      traceparent,
    });
    expect(decision).toMatchObject({ kind, assetId: "a-1", orgId: tenantId });
  });

  it("routes branding.gc_asset → branding-gc-asset with the prefix", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "branding.gc_asset",
      payload: { assetId: "a-1", prefix: `${tenantId}/logo/a-1/` },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "branding-gc-asset",
      assetId: "a-1",
      orgId: tenantId,
      prefix: `${tenantId}/logo/a-1/`,
      traceparent,
    });
  });

  it("routes keycloak.sync_org_logo → keycloak-sync-org-logo", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "keycloak.sync_org_logo",
      payload: {},
      traceparent,
    });
    expect(decision).toEqual({
      kind: "keycloak-sync-org-logo",
      orgId: tenantId,
      traceparent,
    });
  });

  it("routes custom_field.option_merge_requested → custom-field-option-merge (Epic #539)", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "custom_field.option_merge_requested",
      payload: {
        mergeId: "merge-1",
        definitionId: "def-1",
        sourceOptionId: "opt_aaaaaaaa",
        targetOptionId: "opt_bbbbbbbb",
        requestedBy: "33333333-3333-3333-3333-333333333333",
      },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "custom-field-option-merge",
      orgId: tenantId,
      mergeId: "merge-1",
      definitionId: "def-1",
      sourceOptionId: "opt_aaaaaaaa",
      targetOptionId: "opt_bbbbbbbb",
      requestedBy: "33333333-3333-3333-3333-333333333333",
      traceparent,
    });
  });

  it("preserves null requestedBy on option-merge when the field is missing", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "custom_field.option_merge_requested",
      payload: {
        mergeId: "merge-1",
        definitionId: "def-1",
        sourceOptionId: "opt_aaaaaaaa",
        targetOptionId: "opt_bbbbbbbb",
      },
      traceparent,
    });
    expect(decision).toMatchObject({ kind: "custom-field-option-merge", requestedBy: null });
  });

  it("routes custom_field.option_merge_undo_requested → custom-field-option-merge-undo", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "custom_field.option_merge_undo_requested",
      payload: {
        mergeId: "merge-1",
        definitionId: "def-1",
        sourceOptionId: "opt_aaaaaaaa",
        targetOptionId: "opt_bbbbbbbb",
        requestedBy: "33333333-3333-3333-3333-333333333333",
      },
      traceparent,
    });
    expect(decision).toEqual({
      kind: "custom-field-option-merge-undo",
      orgId: tenantId,
      mergeId: "merge-1",
      definitionId: "def-1",
      sourceOptionId: "opt_aaaaaaaa",
      targetOptionId: "opt_bbbbbbbb",
      requestedBy: "33333333-3333-3333-3333-333333333333",
      traceparent,
    });
  });

  it("returns unhandled for an unknown type so the worker logs a breadcrumb instead of throwing", () => {
    const decision = routeDomainEvent({
      id,
      tenantId,
      type: "definitely.not.a.real.event",
      payload: {},
      traceparent,
    });
    expect(decision).toEqual({ kind: "unhandled", type: "definitely.not.a.real.event" });
  });
});
