/**
 * Team-invite email processor — integration test (issue #145).
 *
 * Mirrors the signup-email integration test: real DB lookup, mocked
 * EmailSender. Verifies the worker:
 *   - Looks up the invitation by id + tenant + purpose='team_invite'.
 *   - Renders the right (EN/FR) template and personalises with the inviter.
 *   - No-ops on already-accepted / not-found events (terminal, no retry).
 */

import { randomUUID } from "node:crypto";
import { invitations, tenants, users } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import {
  processTeamInviteEmail,
  type TeamInviteEmailJobPayload,
} from "../../processors/team-invite-email.js";

const ORG_ID = "00000000-0000-0000-0000-0000000001a1";
const INVITER_USER_ID = "00000000-0000-0000-0000-0000000001a2";
const INVITATION_ID = "00000000-0000-0000-0000-0000000001a3";
const INVITATION_TOKEN = "00000000-0000-0000-0000-0000000001a4";

const ORG_ID_FR = "00000000-0000-0000-0000-0000000001b1";
const INVITATION_ID_FR = "00000000-0000-0000-0000-0000000001b3";
const INVITATION_TOKEN_FR = "00000000-0000-0000-0000-0000000001b4";

const ORG_ID_ACCEPTED = "00000000-0000-0000-0000-0000000001c1";
const INVITATION_ID_ACCEPTED = "00000000-0000-0000-0000-0000000001c3";

beforeAll(async () => {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${ORG_ID}, 'Acme Charity', ${`team-invite-${randomUUID().slice(0, 8)}`}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await db.execute(
    sql`INSERT INTO users (id, org_id, email, first_name, last_name, role, keycloak_id)
        VALUES (${INVITER_USER_ID}, ${ORG_ID}, 'inviter@acme.org', 'Alice', 'Inviter', 'org_admin', 'kc-inviter-acme')
        ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name`,
  );
  await db
    .insert(invitations)
    .values({
      id: INVITATION_ID,
      orgId: ORG_ID,
      email: "newbie@acme.org",
      role: "user",
      token: INVITATION_TOKEN,
      invitedById: INVITER_USER_ID,
      purpose: "team_invite",
      expiresAt,
    })
    .onConflictDoNothing();

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${ORG_ID_FR}, 'Assoc Demo', ${`team-invite-fr-${randomUUID().slice(0, 8)}`}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await db
    .insert(invitations)
    .values({
      id: INVITATION_ID_FR,
      orgId: ORG_ID_FR,
      email: "newbie@assoc.fr",
      role: "org_admin",
      token: INVITATION_TOKEN_FR,
      purpose: "team_invite",
      expiresAt,
    })
    .onConflictDoNothing();

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${ORG_ID_ACCEPTED}, 'Done Corp', ${`team-invite-done-${randomUUID().slice(0, 8)}`}, 'active', 'enterprise')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await db
    .insert(invitations)
    .values({
      id: INVITATION_ID_ACCEPTED,
      orgId: ORG_ID_ACCEPTED,
      email: "done@example.org",
      role: "user",
      token: randomUUID(),
      purpose: "team_invite",
      expiresAt,
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(invitations).where(eq(invitations.id, INVITATION_ID));
  await db.delete(invitations).where(eq(invitations.id, INVITATION_ID_FR));
  await db.delete(invitations).where(eq(invitations.id, INVITATION_ID_ACCEPTED));
  await db.delete(users).where(eq(users.id, INVITER_USER_ID));
  await db.delete(tenants).where(eq(tenants.id, ORG_ID));
  await db.delete(tenants).where(eq(tenants.id, ORG_ID_FR));
  await db.delete(tenants).where(eq(tenants.id, ORG_ID_ACCEPTED));
});

function makeSender() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe("processTeamInviteEmail", () => {
  it("sends a personalised English email with the accept URL", async () => {
    const sender = makeSender();
    const payload: TeamInviteEmailJobPayload = {
      tenantId: ORG_ID,
      invitationId: INVITATION_ID,
      inviterUserId: INVITER_USER_ID,
      locale: "en",
    };

    const result = await processTeamInviteEmail(payload, { sender });
    expect(result).toEqual({ sent: true });
    expect(sender.send).toHaveBeenCalledTimes(1);
    const call = sender.send.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.to).toBe("newbie@acme.org");
    expect(call.subject).toContain("Acme Charity");
    expect(call.subject).toContain("Alice Inviter");
    expect(call.html).toContain(`/invite/accept?token=${INVITATION_TOKEN}`);
    expect(call.text).toContain(`/invite/accept?token=${INVITATION_TOKEN}`);
  });

  it("falls back to a generic inviter when inviterUserId is null", async () => {
    const sender = makeSender();
    await processTeamInviteEmail(
      { tenantId: ORG_ID, invitationId: INVITATION_ID, inviterUserId: null, locale: "en" },
      { sender },
    );
    const call = sender.send.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) return;
    // Subject still contains the tenant name; inviter falls back to "A colleague".
    expect(call.subject).toContain("A colleague");
  });

  it("picks the French template when locale=fr", async () => {
    const sender = makeSender();
    await processTeamInviteEmail(
      {
        tenantId: ORG_ID_FR,
        invitationId: INVITATION_ID_FR,
        inviterUserId: null,
        locale: "fr",
      },
      { sender },
    );
    const call = sender.send.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.subject).toContain("Assoc Demo");
    expect(call.subject).toMatch(/invite à rejoindre/);
    expect(call.html).toContain(`/invite/accept?token=${INVITATION_TOKEN_FR}`);
  });

  it("no-ops on an already-accepted invitation", async () => {
    const sender = makeSender();
    const result = await processTeamInviteEmail(
      { tenantId: ORG_ID_ACCEPTED, invitationId: INVITATION_ID_ACCEPTED, locale: "en" },
      { sender },
    );
    expect(result).toEqual({ sent: false, reason: "already_accepted" });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("no-ops when the invitation id does not match the tenant", async () => {
    const sender = makeSender();
    const result = await processTeamInviteEmail(
      { tenantId: ORG_ID, invitationId: randomUUID(), locale: "en" },
      { sender },
    );
    expect(result).toEqual({ sent: false, reason: "not_found" });
    expect(sender.send).not.toHaveBeenCalled();
  });
});
