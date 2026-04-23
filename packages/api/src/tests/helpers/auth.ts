/** Shared test helpers — auth tokens, tenant constants, and fixture setup */

import { createSign } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";

export const ORG_A = "00000000-0000-0000-0000-000000000001";
export const ORG_B = "00000000-0000-0000-0000-000000000002";
export const USER_A = "00000000-0000-0000-0000-000000000099";
export const USER_B = "00000000-0000-0000-0000-000000000098";

const TEST_JWT_ISSUER = process.env.KEYCLOAK_ISSUER ?? "https://keycloak.test/realms/givernance";
const TEST_JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDDTnEsAWu8ebyv
DCW8DYnK183W9bQkqxRwOYh6zYmBi7euZLu5CwWKjBQIXK2RiNoE2qraFX6qiz45
6bBpDgCS1S1i14XQBOre6/9fl5hJ+obUPYbG9ro22zB0vZhmkNjc7qj2vevzUzo3
M25AK2Wc+J6dgf2MCjHkijkKuc+0Ln94XqAtpTUXCcYClATXFKkCPFwQ6HXickuK
779uFmT/KSjjCuIHQak82nK00fTvXVWzam+lGEvDX9kSOTyU8iO54YaDUmbOevpv
oP9cHqN3C5che4+WUDxOKt7Bqz76vA7BpCd94ptdxc9+SMNgyOJcMBCiq3uuK7hO
fKo32/01AgMBAAECggEAStl6tPc8b2imX93Dbm0v1E3dhNb4eZ8ZP6NFA29XFg9S
T2MqsJGhR4ZEvSmrmV191KNrHBZly31+1RoS8kgb/yn08W8QyPbBfrqqTdve0OdT
Ge8UgpcXKaPaT7tDt3cmrZFHrvx9e2z3oCU1SSF4mW6M92dUoQFdOq2gi9RHXlFS
KQhK8rP2LsNC4zDQcT9F0lD2wiCDyoUFFeQWkO6Bdg91u+zY40kgn8ppXYT77Eyl
l82jgnHhoU4sbxJEWxi2nnP1KpFnrVRtPegdi3R0LM8oZWVxp2HaUftOWmw+wH2G
NwIVsKI2FcBqwLVJ2wgO0xsNZSXLIltP61WJUSzbNwKBgQDnkYw/cZ4PHyjOGiFr
js3arjGPzlhrrPX7xMai8ih4n+QyePJ9nBKfMU/M4FybJhCCe5lZ2jFefqOfP4dM
Mkb2N/TcrWuaGL6tyT9JfxAVTG66l4362+Z/dcGUC7AjZl7h6sHBaZEhruYaTuwL
Pr9hcjzJSjIqkhKI2dAVyFb8wwKBgQDX6XzTyZmkJ35eo4OBu1+MLZPuoh/xjYuv
mYvWFuFTlKx+uE5++ANueP+e1V34PwxbzE8Xg6cIy+pS+cLJt2ncrJbppTyaTOzL
a77kCOpLT6dshcqhX63nL8uhe37MVeV6NyeUDjbGGg2YJ83UdbK0p4mGwEmnYKim
+LfteaTepwKBgQChc6Qh89hs2J+9mxBkCmvSJRNfHVIeuLfEcvy/TTEUcP5MhnEj
TLbbESl/QYqvjYmDQCO6Ntum84qnFEcDxCYfswHg/nSAOvJu/lpGpvWSs/ib1eDi
34DEq1htHP0QoWZUAzZV4IGUx3mdLBt896G9kkV5Xma9sZyEl8Bx/31OuwKBgGMk
PoJNRvRegiNYt9EBRd1rLEtePIbBNQv72H8E4JBta0uAu+KHZaP7gXzggpaz9KvO
Q98LP87FO6LANtZDFyQSR/WfPxWnDvBVWEEDavoL6Ffnk2TIN2U5yCotN8sCAi49
Vzof0LzkR6u/Uz8kkFtttrOeZfOqaabJ/ELaIX9vAoGAf57TT5uT0J3MWwzXgFgo
1PXH6WMAHhnFjMIQ6jLMLkpuZcPm6FQNX53Vi7RJfS3uyarBLi73L5gvKBKwVsRE
zRHOLKuQY8ajG/W0iETCAmOHX52jfeP6Cpin5pIAoMQmOlO8zZUaykOXsRbvuDGO
RuJJOGJwzoqj7EyWXdpSMQE=
-----END PRIVATE KEY-----`;

/** Sign a JWT token defaulting to Tenant A / User A / org_admin */
export function signToken(_app: FastifyInstance, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: TEST_JWT_ISSUER,
    sub: USER_A,
    org_id: ORG_A,
    realm_access: { roles: ["admin"] },
    email: "user-a@example.org",
    role: "org_admin",
    iat: now,
    exp: now + 8 * 60 * 60,
    ...claims,
  };

  return signJwt(payload);
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

function signJwt(payload: Record<string, unknown>) {
  const header = { alg: "RS256", kid: "test-key-1", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(TEST_JWT_PRIVATE_KEY);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}
