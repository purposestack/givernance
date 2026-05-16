/**
 * Unit tests for `planFanout()` — the pure planner that translates
 * outbox events into notification plan entries. No DB / Redis /
 * BullMQ — pure function tests so regressions in event-name mapping
 * fail fast in CI.
 */

import { BRANDING_EVENT_TYPES } from "@givernance/shared/jobs";
import { describe, expect, it } from "vitest";
import { planFanout } from "./notifications-fanout.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function inputFor(type: string, payload: Record<string, unknown> = {}) {
  return {
    outboxId: "00000000-0000-0000-0000-000000000abc",
    tenantId: TENANT_ID,
    type,
    payload,
  };
}

describe("planFanout — supported event types", () => {
  it("donation.created → all org_admins, links to donation page", () => {
    const plan = planFanout(
      inputFor("donation.created", {
        donationId: "00000000-0000-0000-0000-0000000000d1",
        amountCents: 5000,
        currency: "EUR",
      }),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      type: "donation.received",
      recipients: { kind: "all_org_admins" },
      linkUrl: "/donations/00000000-0000-0000-0000-0000000000d1",
    });
    expect(plan[0]?.params).toMatchObject({ amountCents: 5000, currency: "EUR" });
  });

  it("invitation.created and invitation.resent map to distinct types", () => {
    const created = planFanout(
      inputFor("invitation.created", { invitationId: "00000000-0000-0000-0000-0000000000a1" }),
    );
    const resent = planFanout(
      inputFor("invitation.resent", { invitationId: "00000000-0000-0000-0000-0000000000a1" }),
    );
    expect(created[0]?.type).toBe("invitation.created");
    expect(resent[0]?.type).toBe("invitation.resent");
    expect(created[0]?.recipients).toEqual({ kind: "all_org_admins" });
    expect(resent[0]?.recipients).toEqual({ kind: "all_org_admins" });
  });

  it("branding.activate_logo → all org_admins, system visual", () => {
    const plan = planFanout(
      inputFor(BRANDING_EVENT_TYPES.ACTIVATE_LOGO, {
        assetId: "00000000-0000-0000-0000-000000000b1",
      }),
    );
    expect(plan[0]?.type).toBe("branding.logo_synced");
    expect(plan[0]?.recipients).toEqual({ kind: "all_org_admins" });
  });

  it("campaign.postal_export_requested with requestedBy → specific user", () => {
    const plan = planFanout(
      inputFor("campaign.postal_export_requested", {
        requestedBy: "00000000-0000-0000-0000-0000000000u1",
        campaignId: "00000000-0000-0000-0000-0000000000c1",
        exportId: "00000000-0000-0000-0000-0000000000e1",
      }),
    );
    expect(plan[0]?.recipients).toEqual({
      kind: "specific_user",
      userId: "00000000-0000-0000-0000-0000000000u1",
    });
    expect(plan[0]?.linkUrl).toBe("/campaigns/00000000-0000-0000-0000-0000000000c1");
  });

  it("campaign.postal_export_requested without requestedBy → all org_admins fallback", () => {
    const plan = planFanout(
      inputFor("campaign.postal_export_requested", {
        campaignId: "00000000-0000-0000-0000-0000000000c1",
        exportId: "00000000-0000-0000-0000-0000000000e1",
      }),
    );
    expect(plan[0]?.recipients).toEqual({ kind: "all_org_admins" });
  });

  it("communication.bulk_email_requested with requestedBy → specific user", () => {
    const plan = planFanout(
      inputFor("communication.bulk_email_requested", {
        requestedBy: "00000000-0000-0000-0000-0000000000u2",
        bulkEmailJobId: "00000000-0000-0000-0000-0000000000be",
      }),
    );
    expect(plan[0]?.type).toBe("bulk_email.queued");
    expect(plan[0]?.recipients).toEqual({
      kind: "specific_user",
      userId: "00000000-0000-0000-0000-0000000000u2",
    });
  });
});

describe("planFanout — unsupported / malformed events", () => {
  it("unknown event type → empty plan (worker silently passes through)", () => {
    const plan = planFanout(inputFor("totally.unknown_type", { foo: "bar" }));
    expect(plan).toEqual([]);
  });

  it("donation.created without donationId → empty plan (defensive)", () => {
    const plan = planFanout(inputFor("donation.created", { amountCents: 5000 }));
    expect(plan).toEqual([]);
  });

  it("invitation.created without invitationId → empty plan", () => {
    const plan = planFanout(inputFor("invitation.created", {}));
    expect(plan).toEqual([]);
  });
});
