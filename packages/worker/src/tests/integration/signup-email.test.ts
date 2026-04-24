/**
 * Signup verification email processor — integration test.
 *
 * Uses the real DB to exercise the invitation lookup, and a mocked
 * EmailSender to assert the right recipient, subject, and body are
 * produced. SMTP dispatch is covered by nodemailer's own test suite;
 * we stop at the boundary.
 */

import { randomUUID } from "node:crypto";
import { invitations, tenants } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import {
  processSignupVerificationEmail,
  type SignupEmailJobPayload,
} from "../../processors/signup-email.js";

// Unique IDs so we don't collide with parallel tests (this package now runs
// file-serial but the API package can still touch the same DB).
const ORG_ID = "00000000-0000-0000-0000-0000000000e1";
const INVITATION_ID = "00000000-0000-0000-0000-0000000000e2";
const INVITATION_TOKEN = "00000000-0000-0000-0000-0000000000e3";
const ORG_ID_FR = "00000000-0000-0000-0000-0000000000e4";
const INVITATION_ID_FR = "00000000-0000-0000-0000-0000000000e5";
const INVITATION_TOKEN_FR = "00000000-0000-0000-0000-0000000000e6";
const ORG_ID_ACCEPTED = "00000000-0000-0000-0000-0000000000e7";
const INVITATION_ID_ACCEPTED = "00000000-0000-0000-0000-0000000000e8";

beforeAll(async () => {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // English-default tenant (no FR country hint).
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${ORG_ID}, 'Acme Charity', ${`signup-email-acme-${randomUUID().slice(0, 8)}`}, 'provisional', 'self_serve')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await db
    .insert(invitations)
    .values({
      id: INVITATION_ID,
      orgId: ORG_ID,
      email: "admin@acme.org",
      role: "org_admin",
      token: INVITATION_TOKEN,
      purpose: "signup_verification",
      expiresAt,
    })
    .onConflictDoNothing();

  // French-locale tenant — same fixture with country='FR' on the job.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${ORG_ID_FR}, 'Assoc Demo', ${`signup-email-fr-${randomUUID().slice(0, 8)}`}, 'provisional', 'self_serve')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await db
    .insert(invitations)
    .values({
      id: INVITATION_ID_FR,
      orgId: ORG_ID_FR,
      email: "admin@assoc.fr",
      role: "org_admin",
      token: INVITATION_TOKEN_FR,
      purpose: "signup_verification",
      expiresAt,
    })
    .onConflictDoNothing();

  // Already-accepted invitation — processor should no-op.
  // `tenants_self_serve_requires_verification_chk` demands verified_at for
  // self-serve tenants that are already active; provide one.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, verified_at)
        VALUES (${ORG_ID_ACCEPTED}, 'Done Charity', ${`signup-email-done-${randomUUID().slice(0, 8)}`}, 'active', 'self_serve', now())
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await db
    .insert(invitations)
    .values({
      id: INVITATION_ID_ACCEPTED,
      orgId: ORG_ID_ACCEPTED,
      email: "done@charity.org",
      role: "org_admin",
      token: randomUUID(),
      purpose: "signup_verification",
      expiresAt,
      acceptedAt: new Date(),
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(invitations).where(eq(invitations.id, INVITATION_ID));
  await db.delete(invitations).where(eq(invitations.id, INVITATION_ID_FR));
  await db.delete(invitations).where(eq(invitations.id, INVITATION_ID_ACCEPTED));
  await db.delete(tenants).where(eq(tenants.id, ORG_ID));
  await db.delete(tenants).where(eq(tenants.id, ORG_ID_FR));
  await db.delete(tenants).where(eq(tenants.id, ORG_ID_ACCEPTED));
});

function makeSender() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe("processSignupVerificationEmail", () => {
  it("sends an English email with the verification URL", async () => {
    const sender = makeSender();
    const payload: SignupEmailJobPayload = {
      tenantId: ORG_ID,
      invitationId: INVITATION_ID,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    const result = await processSignupVerificationEmail(payload, { sender });

    expect(result).toEqual({ sent: true });
    expect(sender.send).toHaveBeenCalledTimes(1);
    const call = sender.send.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.to).toBe("admin@acme.org");
    expect(call.subject).toContain("Acme Charity");
    expect(call.subject).toMatch(/Confirm|Givernance/);
    expect(call.html).toContain(`/signup/verify?token=${INVITATION_TOKEN}`);
    expect(call.text).toContain(`/signup/verify?token=${INVITATION_TOKEN}`);
  });

  it("picks French templates when country=FR", async () => {
    const sender = makeSender();
    await processSignupVerificationEmail(
      {
        tenantId: ORG_ID_FR,
        invitationId: INVITATION_ID_FR,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        country: "FR",
      },
      { sender },
    );

    const call = sender.send.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.subject).toContain("Assoc Demo");
    expect(call.subject).toMatch(/Confirmez/);
    expect(call.html).toContain(`/signup/verify?token=${INVITATION_TOKEN_FR}`);
  });

  it("no-ops on an already-accepted invitation", async () => {
    const sender = makeSender();
    const result = await processSignupVerificationEmail(
      {
        tenantId: ORG_ID_ACCEPTED,
        invitationId: INVITATION_ID_ACCEPTED,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      { sender },
    );

    expect(result).toEqual({ sent: false, reason: "already_accepted" });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("no-ops when the invitation id does not match the tenant", async () => {
    const sender = makeSender();
    const result = await processSignupVerificationEmail(
      {
        tenantId: ORG_ID,
        invitationId: randomUUID(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      { sender },
    );

    expect(result).toEqual({ sent: false, reason: "not_found" });
    expect(sender.send).not.toHaveBeenCalled();
  });
});
