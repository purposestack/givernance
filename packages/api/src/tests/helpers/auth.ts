/** Shared test helpers — auth tokens, tenant constants, and fixture setup */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";

export const ORG_A = "00000000-0000-0000-0000-000000000001";
export const ORG_B = "00000000-0000-0000-0000-000000000002";
export const USER_A = "00000000-0000-0000-0000-000000000099";
export const USER_B = "00000000-0000-0000-0000-000000000098";

/** Sign a JWT token defaulting to Tenant A / User A / org_admin */
export function signToken(app: FastifyInstance, claims: Record<string, unknown> = {}) {
  return app.jwt.sign({
    sub: USER_A,
    org_id: ORG_A,
    realm_access: { roles: ["admin"] },
    email: "user-a@example.org",
    role: "org_admin",
    ...claims,
  });
}

/** Sign a JWT token for Tenant B / User B */
export function signTokenB(app: FastifyInstance, claims: Record<string, unknown> = {}) {
  return signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org", ...claims });
}

/** Build an Authorization header from a token */
export function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Upsert both test tenants (idempotent) */
export async function ensureTestTenants() {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_A}, 'Org A', 'test-org-a') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-org-b') ON CONFLICT (id) DO NOTHING`,
  );
}
