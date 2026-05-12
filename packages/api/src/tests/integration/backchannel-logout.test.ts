/**
 * Back-channel logout endpoint tests (issue #76 / PR-2).
 *
 * Coverage:
 *   - Happy path: spec-compliant token → 200, sid persisted in Redis
 *     blocklist with the documented TTL window.
 *   - Propagation: subsequent access token carrying the revoked `sid`
 *     → 401 with `Session revoked.` (auth plugin reads the blocklist).
 *   - JWT-gate exemption (no cookie, no header) → still 200.
 *   - Idempotency: second logout for the same sid → still 200.
 *   - Rejection branches (all 400):
 *       - `nonce` claim present (ID-token replay defence)
 *       - Missing `events` claim
 *       - Wrong `aud` (cross-client misroute)
 *       - Missing `sid` claim
 *       - Non-object `events` URI value
 *       - Empty `logout_token` body
 *       - Wrong signing key (`kid`)
 *       - Wrong issuer
 *       - Expired `iat` (> 5 min skew)
 *   - Back-compat: access token with NO `sid` claim passes through
 *     (already-issued tokens predate PR-3).
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, signLogoutToken, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function formBody(token: string): string {
  return new URLSearchParams({ logout_token: token }).toString();
}

async function postLogoutToken(claims: Record<string, unknown> = {}, opts: { kid?: string } = {}) {
  const { token, sid } = signLogoutToken(claims, opts);
  const res = await app.inject({
    method: "POST",
    url: "/v1/session/backchannel-logout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: formBody(token),
  });
  return { res, sid };
}

describe("POST /v1/session/backchannel-logout — happy path", () => {
  it("accepts a spec-compliant token, returns 200, and blocklists the sid", async () => {
    const { res, sid } = await postLogoutToken();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sid });

    const blocklistKey = `auth:kc-sid-blocklist:${sid}`;
    expect(await redis.get(blocklistKey)).toBe("1");
    // PR #360 review (QA m13): pin the TTL so a regression that swaps
    // `setex` for plain `set` (no expiry) gets caught.
    const ttl = await redis.ttl(blocklistKey);
    expect(ttl).toBeGreaterThan(540); // > 9 min — leaves headroom under the 10-min default
    expect(ttl).toBeLessThanOrEqual(600); // ≤ 10 min ceiling
  });

  it("rejects a subsequent access token carrying the revoked sid", async () => {
    const sid = `kc-sid-rev-${Date.now()}`;
    const { res: logoutRes } = await postLogoutToken({ sid });
    expect(logoutRes.statusCode).toBe(200);

    // Mint an access token with the same sid; auth plugin should 401.
    const accessToken = signToken(app, { sid });
    const meRes = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(accessToken),
    });
    expect(meRes.statusCode).toBe(401);
    expect(meRes.json()).toMatchObject({
      status: 401,
      title: "Unauthorized",
      detail: "Session revoked.",
    });
  });

  it("does NOT require a JWT cookie or auth header (server-to-server call)", async () => {
    const { res } = await postLogoutToken();
    expect(res.statusCode).toBe(200);
  });

  it("is idempotent — a second logout for the same sid still returns 200", async () => {
    const sid = `kc-sid-idemp-${Date.now()}`;
    const { res: first } = await postLogoutToken({ sid });
    expect(first.statusCode).toBe(200);

    const { res: second } = await postLogoutToken({ sid });
    expect(second.statusCode).toBe(200);

    // The blocklist entry should still be present and the TTL still bounded.
    expect(await redis.get(`auth:kc-sid-blocklist:${sid}`)).toBe("1");
  });

  it("lets an access token with NO sid claim through (back-compat with already-issued tokens)", async () => {
    // Pre-PR-3 tokens didn't carry `sid` — they should keep working
    // during the rollout window, not silently break.
    const accessToken = signToken(app); // no sid override
    const meRes = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(accessToken),
    });
    // 200 (or any non-401-session-revoked code) is the contract here.
    expect(meRes.statusCode).not.toBe(401);
  });
});

describe("POST /v1/session/backchannel-logout — claim rejections", () => {
  it("400s a token carrying a `nonce` claim (ID-token replay defence)", async () => {
    const { res } = await postLogoutToken({ nonce: "should-not-be-here" });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token missing the `events` claim", async () => {
    const { res } = await postLogoutToken({ events: undefined });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token with the wrong audience (cross-client misroute)", async () => {
    const { res } = await postLogoutToken({ aud: "givernance-admin" });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token missing the `sid` claim", async () => {
    const { res } = await postLogoutToken({ sid: undefined });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token with `events` set to a non-object value at the spec URI", async () => {
    const { res } = await postLogoutToken({
      events: { "http://schemas.openid.net/event/backchannel-logout": "not-an-object" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a missing logout_token body field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/session/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "logout_token=",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/session/backchannel-logout — cryptographic rejections", () => {
  it("400s a token signed with an unknown key id (wrong `kid`)", async () => {
    // PR #360 review QA M2 — without this, a regression that disables
    // signature verification and reads claims off `decodeJwt()` would
    // still pass every claim-validation test.
    const { res } = await postLogoutToken({}, { kid: "unknown-key-id" });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token signed by the wrong issuer (cross-realm key reuse)", async () => {
    const { res } = await postLogoutToken({
      iss: "https://keycloak.test/realms/some-other-realm",
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a token with `iat` past the 5-minute skew window", async () => {
    const tenMinAgo = Math.floor(Date.now() / 1000) - 10 * 60;
    const { res } = await postLogoutToken({ iat: tenMinAgo });
    expect(res.statusCode).toBe(400);
  });
});
